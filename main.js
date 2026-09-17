#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { program } = require('commander');
const pkg = require('./package.json');
const { chunksToRawFramesOfSize, getFrameSize, MAX_FRAME_BYTES } = require('./lib/frames');
const { asciiFromBGRA, cellsFromBGRA, cellsToString, stripAnsi } = require('./lib/ascii');
const { diffGrids, runsToAnsi } = require('./lib/diff');
const { getVideoInfo, decodeBGRAStream, isStillImage } = require('./lib/video');
const { audioRequested, resolveAudioPlayer, hasAudioStream, spawnAudioPlayer } = require('./lib/audio');
const { createScheduler } = require('./lib/scheduler');

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

function parsePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (got ${value})`);
  return n;
}

function parseNumberOption(value, name, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be in ${min}..${max} (got ${value})`);
  }
  return n;
}

function termSize() {
  const w = Number(process.stdout.columns) || 80;
  const h = Number(process.stdout.rows) || 24;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

function addSharedOptions(cmd) {
  return cmd
    .option('-W, --width <n>', 'output width in characters (default: fit terminal)')
    .option('-H, --height <n>', 'output height in characters (default: fit terminal)')
    .option('--fps <n>', 'limit output frame rate (default: source rate)')
    .option('--chars <string>', 'ramp from dark to bright (default: " .,:;i1tfLCG08@")')
    .option('--color', 'ANSI truecolor output (default)', true)
    .option('--no-color', 'plain ASCII without color codes')
    .option('--invert', 'reverse the character ramp (negative image)')
    .option('--dither', 'Bayer ordered dithering (less banding, more texture)')
    .option('--contrast <n>', 'contrast multiplier, (0, 5] (default: 1)', '1')
    .option('--brightness <n>', 'brightness offset per channel, -255..255 (default: 0)', '0')
    .option('--char-aspect <n>', 'character cell height/width ratio override')
    .option('--no-fit', 'ignore terminal aspect fitting (use raw terminal size)')
    .option('--ffmpeg <path>', 'ffmpeg binary path (or FFMPEG_PATH env)')
    .option('--ffprobe <path>', 'ffprobe binary path (or FFPROBE_PATH env)');
}

function resolveRenderOptions(cmdOpts) {
  const o = { ...cmdOpts };
  if (o.width != null) o.width = parsePositiveInt(o.width, 'width');
  if (o.height != null) o.height = parsePositiveInt(o.height, 'height');
  if (o.fps != null) o.fps = parseNumberOption(o.fps, 'fps', { min: 0.1, max: 240 });
  if (o.contrast != null) o.contrast = parseNumberOption(o.contrast, 'contrast', { min: 0.01, max: 5 });
  if (o.brightness != null) o.brightness = parseNumberOption(o.brightness, 'brightness', { min: -255, max: 255 });
  if (o.charAspect != null) o.charAspect = parseNumberOption(o.charAspect, 'char-aspect', { min: 0.01, max: 10 });
  if (o.chars != null && String(o.chars).length < 2) throw new Error('chars must contain at least 2 characters');
  o.ffmpegPath = o.ffmpeg || process.env.FFMPEG_PATH || undefined;
  o.ffprobePath = o.ffprobe || process.env.FFPROBE_PATH || undefined;
  // Any audio flag implies --audio (explicit player or volume = intent to hear sound).
  if (o.volume != null) {
    const v = Number(o.volume);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`volume must be in 0..100 (got ${o.volume})`);
    o.volume = v;
  }
  o.audioPlayer = o.audioPlayer || undefined;
  o.audio = audioRequested(o);
  return o;
}

function writeStdout(chunk) {
  try {
    process.stdout.write(chunk);
  } catch (err) {
    if (err && err.code !== 'EPIPE') throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Above this changed-cell ratio, a delta costs more than a full redraw.
const FULL_REDRAW_RATIO = 0.6;

function asciiOptsFor(opts) {
  return {
    chars: opts.chars,
    colored: opts.color,
    reverse: opts.invert,
    dither: opts.dither,
    contrast: opts.contrast,
    brightness: opts.brightness,
  };
}

async function renderOnce(input, opts) {
  const info = await getVideoInfo(input, opts);
  const frameSize = getFrameSize(termSize(), { w: info.w, h: info.h }, opts);
  const decode = decodeBGRAStream(input, frameSize, { ...opts, realtime: false, frames: 1 });
  const decodeError = new Promise((_, reject) => {
    decode.on('error', reject);
  });
  const dechunk = chunksToRawFramesOfSize(frameSize.w, frameSize.h);
  let frame = null;
  try {
    await Promise.race([
      (async () => {
        for await (const f of dechunk(decode.stdout)) {
          frame = f;
          break;
        }
      })(),
      decodeError,
    ]);
  } finally {
    decode.kill('SIGKILL');
  }
  if (!frame) {
    const tail = decode.decodeStderr ? decode.decodeStderr() : '';
    throw new Error(`no frames decoded${tail ? `: ${tail}` : ''}`);
  }
  const ascii = asciiFromBGRA(frame, frameSize.w, asciiOptsFor(opts));
  return { ascii, frameSize, info };
}

async function playStream(input, opts) {
  const display = opts.display !== false;
  const needOutput = Boolean(opts.output);
  if (!display && !needOutput) {
    throw new Error('--no-display requires --output <file>');
  }
  const info = await getVideoInfo(input, opts);

  // Presentation scheduler: drop render work when behind, sleep when early.
  // Decode restarts from frame 0 on resize, so the scheduler resets too.
  let sched = createScheduler({ fps: opts.fps ?? info.fps, duration: info.duration });

  // Still images play as a single rendered frame (unless looping a gif).
  if (isStillImage(info, input) && !opts.loop) {
    if (opts.audio) {
      process.stderr.write('Warning: --audio is only supported for video; ignoring for still image.\n');
    }
    const { ascii } = await renderOnce(input, opts);
    if (display) writeStdout(`${ascii}\n`);
    if (needOutput) await fs.promises.writeFile(opts.output, `${stripAnsi(ascii)}\n`);
    return { frames: 1, restarted: false };
  }

  let outFd = null;
  if (needOutput) {
    outFd = await fs.promises.open(opts.output, 'w');
  }

  let decode = null;
  let statsTimer = null;
  let audioProc = null;  let audioOn = false;
  let audioKillIntended = false;
  let stopped = false;
  let paused = false;
  let resizePending = false;
  let frames = 0;
  // Delta redraw state: previous cell grid + last changed-cell % for --stats.
  // File output always gets full frames; diffs only drive the terminal.
  const useDiff = display && opts.diff !== false;
  let prevGrid = null;
  const diffStats = { pct: null };
  const statsLine = () => {
    const base = sched.status();
    return diffStats.pct == null ? base : `${base} · chg ${diffStats.pct}%`;
  };
  const stdin = process.stdin;
  const stdinWasRaw = Boolean(stdin.isTTY && stdin.isRaw);
  const stdoutIsTTY = Boolean(process.stdout.isTTY);

  const killDecode = () => {
    if (decode && !decode.killed) {
      try {
        decode.kill('SIGTERM');
      } catch { /* already gone */ }
    }
  };

  // Audio runs for the whole session (independent of video resize respawns).
  const killAudio = (sig = 'SIGTERM') => {
    if (audioProc && audioProc.exitCode == null && !audioProc.killed) {
      try {
        audioProc.kill(sig);
        audioKillIntended = true; // ffplay maps SIGTERM to exit 123 — not a failure
      } catch { /* already gone */ }
    }
  };

  const setAudioPaused = (pause) => {
    if (!audioProc || process.platform === 'win32') return;
    try {
      audioProc.kill(pause ? 'SIGSTOP' : 'SIGCONT');
    } catch { /* exited already */ }
  };

  const startAudio = async () => {
    if (!opts.audio) return;
    let has = false;
    try {
      has = await hasAudioStream(input, opts);
    } catch (err) {
      process.stderr.write(`Warning: audio probe failed (${err.message}); playing silently.\n`);
      return;
    }
    if (!has) {
      process.stderr.write('Warning: no audio stream found; playing silently.\n');
      return;
    }
    try {
      audioProc = spawnAudioPlayer(input, opts);
      await new Promise((resolve, reject) => {
        audioProc.once('spawn', resolve);
        audioProc.once('error', reject);
      });
    } catch (err) {
      audioProc = null;
      if (err && err.code === 'ENOENT') {
        throw new Error(
          `audio player '${resolveAudioPlayer(opts)}' not found (install ffplay or pass --audio-player <path>)`
        );
      }
      throw err;
    }
    audioOn = true;
    if (paused) setAudioPaused(true);
    audioProc.on('error', (err) => {
      if (!stopped) process.stderr.write(`Warning: audio player error (${err.message}).\n`);
    });
    audioProc.on('close', (code) => {
      // Ignore our own cleanup kills; a real non-zero exit means the player
      // failed on its own (e.g. no audio device) — say so.
      if (!stopped && !audioKillIntended && code !== 0 && code != null) {
        const tail = audioProc.audioStderr ? audioProc.audioStderr() : '';
        process.stderr.write(
          `Warning: audio player exited with code ${code}${tail ? `: ${tail}` : ''}.\n`
        );
      }
    });
  };

  const cleanupDisplay = () => {
    if (display && stdoutIsTTY) writeStdout(CURSOR_SHOW);
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      try {
        stdin.setRawMode(stdinWasRaw);
        stdin.pause();
      } catch { /* ignore */ }
    }
  };

  const onSigint = () => {
    stopped = true;
    killDecode();
    killAudio();
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigint);

  const onResize = () => {
    if (opts.width != null || opts.height != null || opts.fit === false) return; // fixed size: ignore
    resizePending = true;
    killDecode(); // breaks the inner loop so we respawn at the new size
  };
  let resizeTimer = null;
  const debouncedResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 200);
  };
  if (display && stdoutIsTTY) process.stdout.on('resize', debouncedResize);

  if (display && stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (key) => {
      if (key === ' ' || key === 'p') {
        paused = !paused;
        setAudioPaused(paused);
        if (sched) {
          if (paused) sched.pause();
          else sched.resume();
        }
        process.stderr.write(paused ? '\n[paused — space to resume, q to quit]\n' : '[resumed]\n');
      } else if (key === 'q' || key === '\u0003' || key === '\u001b') {
        stopped = true;
        killDecode();
        killAudio();
      }
    });
  }

  try {
    if (display) {
      if (stdoutIsTTY) writeStdout(CLEAR_SCREEN + CURSOR_HIDE);
      else writeStdout(CURSOR_HOME);
      process.stderr.write('Playing — space pauses, q quits.\n');
    }
    await startAudio();
    if (audioOn) process.stderr.write(`Audio on (${resolveAudioPlayer(opts)}). Sync with video is approximate.\n`);

    if (opts.stats) {
      statsTimer = setInterval(() => {
        process.stderr.write(`\r${statsLine()}`);
      }, 1000);
    }

    let firstSpawn = true;
    while (!stopped) {
      const size = getFrameSize(termSize(), { w: info.w, h: info.h }, opts);
      if (size.w * size.h * 4 > MAX_FRAME_BYTES) {
        throw new Error(`frame size ${size.w}x${size.h} exceeds memory guard`);
      }
      resizePending = false;
      // Fresh decode starts at frame 0: restart timestamps and force a full draw.
      sched = createScheduler({ fps: opts.fps ?? info.fps, duration: info.duration });
      prevGrid = null;
      if (paused) sched.pause();
      decode = decodeBGRAStream(input, size, opts);
      const spawnFailed = new Promise((_, reject) => decode.once('error', reject));
      // Surface a missing binary immediately instead of hanging on stdout.
      await Promise.race([
        new Promise((resolve) => {
          decode.once('spawn', resolve);
          setImmediate(resolve); // 'spawn' may already have fired on fast paths
        }),
        spawnFailed,
      ]);

      const dechunk = chunksToRawFramesOfSize(size.w, size.h);
      let decodeExited = null;
      decode.once('close', (code) => {
        decodeExited = code;
      });

      try {
        let frameIndex = 0;
        for await (const frame of dechunk(decode.stdout)) {
          if (stopped || resizePending) break;
          while (paused && !stopped) {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (stopped || resizePending) break;
          const decision = sched.decide(frameIndex++);
          if (decision.action === 'drop') continue; // behind: skip render+write
          if (decision.waitMs > 0) {
            await sleep(decision.waitMs);
            if (stopped || resizePending) break;
          }
          const asciiOpts = asciiOptsFor(opts);
          const colored = opts.color !== false;
          let grid = null;
          const getGrid = () => (grid ??= cellsFromBGRA(frame, size.w, asciiOpts));
          if (display) {
            if (useDiff) {
              const g = getGrid();
              if (prevGrid && prevGrid.width === g.width && prevGrid.height === g.height) {
                const d = diffGrids(prevGrid, g);
                diffStats.pct = d.total === 0 ? 0 : Math.round((d.changed / d.total) * 100);
                if (d.changed === 0) {
                  // Screen already shows this frame — nothing to write.
                } else if (d.changed / d.total > FULL_REDRAW_RATIO) {
                  writeStdout(`${CURSOR_HOME}${cellsToString(g, colored)}`);
                } else {
                  writeStdout(runsToAnsi(d.runs, colored));
                }
              } else {
                writeStdout(`${CURSOR_HOME}${cellsToString(g, colored)}`);
                diffStats.pct = 100;
              }
              prevGrid = g;
            } else {
              writeStdout(`${CURSOR_HOME}${asciiFromBGRA(frame, size.w, asciiOpts)}`);
            }
          }
          if (outFd) {
            const text = grid ? cellsToString(grid, colored) : asciiFromBGRA(frame, size.w, asciiOpts);
            await outFd.write(`${stripAnsi(text)}\n\x0c\n`);
          }
          frames++;
          void firstSpawn;
          firstSpawn = false;
        }
      } catch (err) {
        if (!stopped) throw err;
      }

      const exitCode = await new Promise((resolve) => {
        if (decode.exitCode != null) return resolve(decode.exitCode);
        decode.once('close', resolve);
        setTimeout(() => {
          if (decode.exitCode == null) {
            decode.kill('SIGKILL');
            resolve(null);
          }
        }, 5000);
      }).catch(() => null);

      if (stopped && !resizePending) break;
      if (resizePending && !stopped) continue; // respawn at new terminal size
      if (exitCode !== 0 && exitCode != null) {
        const tail = decode.decodeStderr ? decode.decodeStderr() : '';
        throw new Error(`ffmpeg exited with code ${exitCode}${tail ? `: ${tail}` : ''}`);
      }
      void decodeExited;
      break; // natural end of stream
    }
  } finally {
    clearTimeout(resizeTimer);
    if (statsTimer) {
      clearInterval(statsTimer);
      process.stderr.write(`\r${statsLine()}\n`);
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);
    if (display && stdoutIsTTY) process.stdout.removeListener('resize', debouncedResize);
    if (stdin.isTTY) stdin.removeAllListeners('data');
    killDecode();
    killAudio();
    cleanupDisplay();
    if (outFd) await outFd.close().catch(() => {});
    if (display) writeStdout('\n');
  }
  return { frames, restarted: false };
}

program
  .name('ffmpeg-ascii')
  .description('Takes an input video, converts it into ASCII frames, and prints them to screen')
  .version(pkg.version);

addSharedOptions(program.command('play <input>'))
  .description('Play a video (or image) as ASCII in the terminal')
  .option('--loop', 'loop the input indefinitely')
  .option('--output <file>', 'also append plain-text frames to a file (form-feed separated)')
  .option('--no-display', 'do not draw to the terminal (requires --output)')
  .option('--audio', 'play audio via a companion player (ffplay by default)')
  .option('--audio-player <path>', 'audio player binary: ffplay or mpv (or AUDIO_PLAYER env)')
  .option('--volume <n>', 'audio volume 0..100 (player default when omitted)')
  .option('--stats', 'show playback progress and effective fps on stderr')
  .option('--no-diff', 'disable delta redraw (repaint every frame fully)')
  .action(async (input, cmdOpts) => {
    try {
      const opts = resolveRenderOptions(cmdOpts);
      const { frames } = await playStream(input, opts);
      process.stderr.write(`Done — ${frames} frame(s).\n`);
    } catch (err) {
      process.stderr.write(`Error: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  });

addSharedOptions(program.command('render <input>'))
  .description('Render a single frame (image or first video frame) to stdout')
  .option('--output <file>', 'write plain-text frame to a file instead of stdout')
  .action(async (input, cmdOpts) => {
    try {
      const opts = resolveRenderOptions(cmdOpts);
      const { ascii } = await renderOnce(input, opts);
      if (opts.output) {
        await fs.promises.writeFile(opts.output, `${stripAnsi(ascii)}\n`);
      } else {
        writeStdout(`${ascii}\n`);
      }
    } catch (err) {
      process.stderr.write(`Error: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  });

module.exports = { playStream, renderOnce, resolveRenderOptions };

if (require.main === module) {
  program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`Error: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
