'use strict';

// Optional audio playback for `play`: a companion audio-only player
// (ffplay by default) runs alongside the ASCII video decode. Timing sync is
// approximate — both sides pace in realtime, which is plenty for ASCII art.
//
// Kept in lib/ (no spawning at require time) so arg building is unit
// testable without audio hardware.

const { spawn } = require('child_process');

const DEFAULT_PLAYER = 'ffplay';
const KNOWN_PLAYERS = new Set(['ffplay', 'mpv']);

function playerBasename(playerPath) {
  return String(playerPath).split('/').pop();
}

/** Explicit --audio-player / AUDIO_PLAYER wins, else the ffplay default. */
function resolveAudioPlayer(opts = {}) {
  return opts.audioPlayer || process.env.AUDIO_PLAYER || DEFAULT_PLAYER;
}

/** True when the user asked for audio via any of the audio flags. */
function audioRequested(opts = {}) {
  return Boolean(opts.audio || opts.audioPlayer || opts.volume != null);
}

function validateVolume(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`volume must be in 0..100 (got ${volume})`);
  }
  return v;
}

/**
 * Build argv for the audio player. The protocol is picked by binary name
 * (substring match, so wrappers like `ffplay-dummy` work). Throws on
 * unknown players or bad volume. ffplay: `-loop 0` loops forever; `-volume`
 * is 0..100. `seek` (seconds) starts playback partway through.
 */
function buildAudioArgs(input, opts = {}) {
  if (!input || typeof input !== 'string') throw new Error('input path required');
  const player = resolveAudioPlayer(opts);
  const base = playerBasename(player);
  const volume = opts.volume != null ? validateVolume(opts.volume) : null;
  let seek = null;
  if (opts.seek != null) {
    seek = Number(opts.seek);
    if (!Number.isFinite(seek) || seek < 0) throw new Error(`seek must be >= 0 (got ${opts.seek})`);
  }

  if (base.includes('ffplay')) {
    const args = ['-nodisp', '-autoexit', '-loglevel', 'error'];
    if (seek) args.push('-ss', String(seek));
    if (opts.loop) args.push('-loop', '0');
    if (volume != null) args.push('-volume', String(volume));
    args.push(input);
    return { player, args };
  }
  if (base.includes('mpv')) {
    const args = ['--no-video', '--really-quiet'];
    if (seek) args.push(`--start=${seek}`);
    if (opts.loop) args.push('--loop=inf');
    if (volume != null) args.push(`--volume=${volume}`);
    args.push(input);
    return { player, args };
  }
  throw new Error(
    `unknown audio player '${player}' (use ffplay, mpv, or a path to one of them)`
  );
}

/**
 * True when the input has at least one audio stream. Never throws for
 * missing streams (ffprobe exits 0 with empty output); throws for missing
 * files/binaries via getVideoInfo-style errors from the caller.
 */
async function hasAudioStream(input, opts = {}) {
  const ffprobe = opts.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe,
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', input],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.on('error', (e) =>
      e && e.code === 'ENOENT'
        ? reject(new Error(`'${ffprobe}' not found on PATH (install ffmpeg: https://ffmpeg.org/download.html)`))
        : reject(e)
    );
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${ffprobe} exited with code ${code}: ${err.trim()}`));
      else resolve(out);
    });
  });
  return stdout.trim().length > 0;
}

/**
 * Spawn the companion audio player (stdio ignored so it never fights the
 * ASCII renderer for stdout or raw-mode stdin). Rejects on spawn failure
 * (e.g. player not installed); later exits are left alone — a short audio
 * track ending before the video is fine. Exposes `audioStderr()`.
 */
function spawnAudioPlayer(input, opts = {}) {
  const { player, args } = buildAudioArgs(input, opts);
  // stdin/stdout ignored so the player never fights the ASCII renderer;
  // stderr piped (and drained) so failures are reportable.
  const child = spawn(player, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      stderrTail += d.toString();
      if (stderrTail.length > 16384) stderrTail = stderrTail.slice(-16384);
    });
  }
  child.audioStderr = () => stderrTail.trim();
  return child;
}

module.exports = {
  resolveAudioPlayer,
  audioRequested,
  validateVolume,
  buildAudioArgs,
  hasAudioStream,
  spawnAudioPlayer,
  DEFAULT_PLAYER,
  KNOWN_PLAYERS,
};
