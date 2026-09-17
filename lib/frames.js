'use strict';

// Frame sizing + raw BGRA stream de-chunking.
// Pure functions (no ffmpeg spawning) so they can be unit tested.

const DEFAULT_CHAR_ASPECT = (1280 / 720) / (211 / 51); // ~0.43, legacy terminal fudge
const MAX_DIMENSION = 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024; // 64 MiB guard against OOM

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DIMENSION) {
    throw new Error(`${name} must be an integer in 1..${MAX_DIMENSION} (got ${value})`);
  }
}

/**
 * Async generator factory: reassembles arbitrary stdout chunks into exact
 * `w*h*4`-byte BGRA frames without O(n^2) Buffer.concat per chunk.
 * Trailing partial frames are dropped (never yielded).
 */
function chunksToRawFramesOfSize(frameWidth, frameHeight) {
  assertPositiveInt(frameWidth, 'frameWidth');
  assertPositiveInt(frameHeight, 'frameHeight');
  const frameBytes = frameWidth * frameHeight * 4;
  if (frameBytes > MAX_FRAME_BYTES) {
    throw new Error(`frame size ${frameWidth}x${frameHeight} exceeds ${MAX_FRAME_BYTES} bytes`);
  }

  return async function* chunksToRawFrames(chunks) {
    if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
      throw new Error('Parameter is not an asynchronous iterable');
    }
    let bufs = [];
    let buffered = 0;

    const takeFrame = () => {
      let frame;
      if (bufs.length === 1 && bufs[0].length === frameBytes) {
        frame = bufs[0];
        bufs = [];
      } else if (bufs[0].length >= frameBytes) {
        frame = Buffer.from(bufs[0].subarray(0, frameBytes));
        bufs[0] = bufs[0].subarray(frameBytes);
        if (bufs[0].length === 0) bufs.shift();
      } else {
        const joined = Buffer.concat(bufs, buffered);
        frame = Buffer.from(joined.subarray(0, frameBytes));
        const rest = joined.subarray(frameBytes);
        bufs = rest.length === 0 ? [] : [Buffer.from(rest)];
      }
      buffered -= frameBytes;
      return frame;
    };

    for await (const chunk of chunks) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error('Stream chunks must be Buffers');
      }
      if (chunk.length === 0) continue;
      bufs.push(chunk);
      buffered += chunk.length;
      while (buffered >= frameBytes) {
        yield takeFrame();
      }
    }
    // Intentionally drop any trailing partial frame.
  };
}

/**
 * Compute the ASCII frame size (in characters) for a terminal.
 * Pure + validated. Explicit width/height overrides skip aspect math.
 */
function getFrameSize(termSize, videoSize, opts = {}) {
  const charAspect = opts.charAspect == null ? DEFAULT_CHAR_ASPECT : opts.charAspect;
  if (!Number.isFinite(charAspect) || charAspect <= 0) {
    throw new Error(`charAspect must be a positive number (got ${opts.charAspect})`);
  }
  for (const [obj, name] of [[termSize, 'termSize'], [videoSize, 'videoSize']]) {
    if (!obj || !Number.isFinite(obj.w) || !Number.isFinite(obj.h) || obj.w <= 0 || obj.h <= 0) {
      throw new Error(`${name} must be {w,h} positive numbers`);
    }
  }

  const explicitW = opts.width != null ? Number(opts.width) : null;
  const explicitH = opts.height != null ? Number(opts.height) : null;
  if (explicitW != null) assertPositiveInt(explicitW, 'width');
  if (explicitH != null) assertPositiveInt(explicitH, 'height');

  const videoAspect = videoSize.w / videoSize.h;

  if (explicitW != null && explicitH != null) {
    return { w: explicitW, h: explicitH };
  }
  if (explicitW != null) {
    return { w: explicitW, h: Math.max(1, Math.round(explicitW / videoAspect * charAspect)) };
  }
  if (explicitH != null) {
    return { w: Math.max(1, Math.floor(explicitH * videoAspect / charAspect)), h: explicitH };
  }
  if (opts.fit === false) {
    return {
      w: Math.min(Math.floor(termSize.w), MAX_DIMENSION),
      h: Math.min(Math.floor(termSize.h), MAX_DIMENSION),
    };
  }

  const termAspect = (termSize.w / termSize.h) * charAspect;
  const frameSize =
    videoAspect > termAspect
      ? { w: Math.floor(termSize.w), h: Math.max(1, Math.floor(termSize.w / videoAspect * charAspect)) }
      : { w: Math.max(1, Math.floor(termSize.h * videoAspect / charAspect)), h: Math.floor(termSize.h) };
  return frameSize;
}

module.exports = {
  chunksToRawFramesOfSize,
  getFrameSize,
  DEFAULT_CHAR_ASPECT,
  MAX_DIMENSION,
  MAX_FRAME_BYTES,
};
