'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFfprobeJson,
  parseFps,
  isStillImage,
  buildVideoFilter,
} = require('../lib/video');

const probeDoc = (stream) => JSON.stringify({ streams: [stream] });

test('parseFps handles ratios, numbers, and unknowns', () => {
  assert.equal(parseFps('5/1'), 5);
  assert.ok(Math.abs(parseFps('30000/1001') - 29.97) < 0.01);
  assert.equal(parseFps('0/0'), null);
  assert.equal(parseFps(null), null);
  assert.equal(parseFps(''), null);
  assert.equal(parseFps(25), 25);
  assert.equal(parseFps(0), null);
});

test('parseFfprobeJson extracts size, fps, duration, codec', () => {
  const info = parseFfprobeJson(
    probeDoc({ width: 64, height: 48, avg_frame_rate: '5/1', r_frame_rate: '5/1', duration: '1.000000', codec_name: 'h264', nb_frames: '5' })
  );
  assert.deepEqual(info, { w: 64, h: 48, fps: 5, duration: 1, codec: 'h264', nbFrames: 5 });
});

test('parseFfprobeJson falls back to r_frame_rate and tolerates missing fields', () => {
  const info = parseFfprobeJson(probeDoc({ width: 32, height: 24, avg_frame_rate: '0/0', r_frame_rate: '25/1', codec_name: 'png' }));
  assert.equal(info.fps, 25);
  assert.equal(info.duration, null);
  assert.equal(info.nbFrames, null);
});

test('parseFfprobeJson rejects garbage', () => {
  assert.throws(() => parseFfprobeJson('not json'), /invalid JSON/);
  assert.throws(() => parseFfprobeJson(JSON.stringify({ streams: [] })), /video size/);
  assert.throws(() => parseFfprobeJson(probeDoc({ width: -1, height: 0 })), /video size/);
});

test('isStillImage distinguishes photos from video', () => {
  const png = { w: 32, h: 24, fps: null, duration: null, codec: 'png', nbFrames: null };
  const mp4 = { w: 64, h: 48, fps: 5, duration: 1, codec: 'h264', nbFrames: 5 };
  assert.equal(isStillImage(png, 'photo.png'), true);
  assert.equal(isStillImage(mp4, 'clip.mp4'), false);
  // Extension fallback when the container reports nothing usable.
  assert.equal(
    isStillImage({ w: 10, h: 10, fps: null, duration: null, codec: null, nbFrames: null }, 'x.jpg'),
    true
  );
});

test('buildVideoFilter composes scale and fps', () => {
  assert.equal(buildVideoFilter({ w: 80, h: 24 }, {}), 'scale=80:24:flags=bicubic');
  assert.equal(
    buildVideoFilter({ w: 80, h: 24 }, { fps: 10 }),
    'scale=80:24:flags=bicubic,fps=10'
  );
  assert.throws(() => buildVideoFilter({ w: 80, h: 24 }, { fps: 0 }), /fps/);
  assert.throws(() => buildVideoFilter({ w: 80 }, {}), /frameSize/);
});
