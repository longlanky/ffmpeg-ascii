'use strict';

// ffprobe-based video probing + ffmpeg rawvideo decoding.
// Replaces the legacy `ffmpeg -i` stderr piped through Unix `sed`.

const fs = require('fs');
const { spawn } = require('child_process');

const IMAGE_CODECS = new Set([
  'png',
  'mjpeg',
  'jpg',
  'jpeg',
  'bmp',
  'tiff',
  'webp',
  'gif',
  'heic',
  'avif',
  'pam',
  'pgm',
  'ppm',
]);

function parseFps(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const s = String(value).trim();
  if (s === '' || s === '0/0') return null;
  if (s.includes('/')) {
    const [num, den] = s.split('/');
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || n <= 0) return null;
    return n / d;
  }
  const f = Number(s);
  return Number.isFinite(f) && f > 0 ? f : null;
}

/** Parse `ffprobe -of json` stdout into {w,h,fps,duration,codec,nbFrames}. Throws on bad input. */
function parseFfprobeJson(stdout) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const stream = doc && doc.streams && doc.streams[0];
  const w = stream && Number(stream.width);
  const h = stream && Number(stream.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error('Could not find video size (no video stream with width/height)');
  }
  const fps = parseFps(stream.avg_frame_rate) ?? parseFps(stream.r_frame_rate);
  const duration = stream.duration != null && Number.isFinite(Number(stream.duration))
    ? Number(stream.duration)
    : null;
  return {
    w,
    h,
    fps,
    duration,
    codec: stream.codec_name || null,
    nbFrames: stream.nb_frames != null ? Number(stream.nb_frames) : null,
  };
}

/** Heuristic: still image (render once) vs. moving video (stream frames). */
function isStillImage(info, inputPath) {
  if (info.fps != null && info.fps > 0) return false;
  if (info.duration != null && info.duration > 0) return false;
  if (info.nbFrames != null && info.nbFrames > 1) return false;
  if (info.codec && IMAGE_CODECS.has(String(info.codec).toLowerCase())) return true;
  return /\.(png|jpe?g|bmp|tiff?|webp|heic|avif|pam|pgm|ppm)$/i.test(inputPath || '');
}

function runAndCollect(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error(`'${cmd}' not found on PATH (install ffmpeg: https://ffmpeg.org/download.html)`));
      } else {
        reject(err);
      }
    });
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        reject(new Error(`${cmd} exited with code ${code}${tail ? `: ${tail}` : ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Probe with ffprobe. Throws with actionable messages on missing file/binary/stream. */
async function getVideoInfo(videoPath, opts = {}) {
  if (!videoPath || typeof videoPath !== 'string') {
    throw new Error('input path must be a non-empty string');
  }
  try {
    await fs.promises.access(videoPath, fs.constants.R_OK);
  } catch {
    throw new Error(`cannot read input file: ${videoPath}`);
  }
  const ffprobe = opts.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  const stdout = await runAndCollect(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,duration,codec_name,nb_frames',
    '-of', 'json',
    videoPath,
  ]);
  return parseFfprobeJson(stdout);
}

function buildVideoFilter(frameSize, opts = {}) {
  if (!frameSize || !Number.isInteger(frameSize.w) || !Number.isInteger(frameSize.h)) {
    throw new Error('frameSize must be {w,h} integers');
  }
  const parts = [`scale=${frameSize.w}:${frameSize.h}:flags=bicubic`];
  if (opts.fps != null) {
    const fps = Number(opts.fps);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
      throw new Error(`fps must be in (0, 240] (got ${opts.fps})`);
    }
    parts.push(`fps=${fps}`);
  }
  return parts.join(',');
}

/**
 * Pure argv builder for the BGRA decode (testable without spawning).
 * opts: { fps, loop, realtime=true, frames, seek } — seek is seconds placed
 * before -i (fast keyframe seek).
 */
function buildDecodeArgs(video, frameSize, opts = {}) {
  if (!video || typeof video !== 'string') throw new Error('video path required');
  const vf = buildVideoFilter(frameSize, opts);
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (opts.loop) args.push('-stream_loop', '-1');
  if (opts.realtime !== false) args.push('-re');
  if (opts.seek != null) {
    const seek = Number(opts.seek);
    if (!Number.isFinite(seek) || seek < 0) throw new Error(`seek must be >= 0 (got ${opts.seek})`);
    if (seek > 0) args.push('-ss', String(seek));
  }
  args.push('-i', video, '-map', '0:v:0', '-an', '-sn', '-vf', vf);
  if (opts.frames != null) args.push('-frames:v', String(Number(opts.frames)));
  args.push('-f', 'rawvideo', '-pix_fmt', 'bgra', '-');
  return args;
}

/**
 * Spawn ffmpeg decoding to BGRA rawvideo on stdout.
 * opts: { fps, loop, realtime=true, frames, seek, ffmpegPath }
 * stderr is captured (last ~64KB) and exposed as `child.decodeStderr()`.
 */
function decodeBGRAStream(video, frameSize, opts = {}) {
  const ffmpeg = opts.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const args = buildDecodeArgs(video, frameSize, opts);

  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      stderrTail += d.toString();
      if (stderrTail.length > 65536) stderrTail = stderrTail.slice(-65536);
    });
  }
  child.decodeStderr = () => stderrTail.trim();
  return child;
}

module.exports = {
  parseFfprobeJson,
  parseFps,
  isStillImage,
  getVideoInfo,
  buildVideoFilter,
  buildDecodeArgs,
  decodeBGRAStream,
};
