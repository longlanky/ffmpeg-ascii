'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chunksToRawFramesOfSize, getFrameSize } = require('../lib/frames');

async function collect(genFactory, chunks) {
  const out = [];
  async function* src() {
    for (const c of chunks) yield c;
  }
  for await (const f of genFactory(src())) out.push(f);
  return out;
}

test('dechunker reassembles split chunks into exact frames', async () => {
  const gen = chunksToRawFramesOfSize(2, 1); // 8 bytes/frame
  const a = Buffer.from([1, 2, 3, 4, 5]);
  const b = Buffer.from([6, 7, 8, 9, 10, 11]);
  const frames = await collect(gen, [a, b]);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
});

test('dechunker splits one big chunk into multiple frames', async () => {
  const gen = chunksToRawFramesOfSize(1, 1); // 4 bytes/frame
  const frames = await collect(gen, [Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])]);
  assert.equal(frames.length, 2); // trailing 1-byte partial dropped
  assert.deepEqual(frames[0], Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(frames[1], Buffer.from([5, 6, 7, 8]));
});

test('dechunker handles byte-at-a-time delivery', async () => {
  const gen = chunksToRawFramesOfSize(2, 1);
  const full = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 9, 9, 9, 255, 8, 8, 8, 255]);
  const chunks = [...full].map((b) => Buffer.from([b]));
  const frames = await collect(gen, chunks);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], full.subarray(8, 16));
});

test('dechunker drops trailing partial frame', async () => {
  const gen = chunksToRawFramesOfSize(2, 2); // 16 bytes/frame
  const frames = await collect(gen, [Buffer.alloc(20, 7)]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 16);
});

test('dechunker rejects bad inputs', async () => {
  const gen = chunksToRawFramesOfSize(2, 1);
  await assert.rejects(async () => {
    for await (const _ of gen([Buffer.alloc(8)])) { /* not async iterable */ }
  }, /asynchronous iterable/);
  await assert.rejects(async () => {
    async function* src() { yield 'not-a-buffer'; }
    for await (const _ of gen(src())) { /* drain */ }
  }, /must be Buffers/);
  assert.throws(() => chunksToRawFramesOfSize(0, 10), /frameWidth/);
});

test('getFrameSize fits wide video to terminal width (legacy math)', () => {
  // 1280x720 on its reference 211x51 terminal fills exactly.
  assert.deepEqual(getFrameSize({ w: 211, h: 51 }, { w: 1280, h: 720 }), { w: 211, h: 51 });
  // Narrow terminal, wide video -> width-bound.
  const s = getFrameSize({ w: 80, h: 24 }, { w: 1280, h: 720 });
  assert.equal(s.w, 80);
  assert.ok(s.h >= 1 && s.h <= 24);
});

test('getFrameSize explicit overrides skip aspect math', () => {
  assert.deepEqual(
    getFrameSize({ w: 80, h: 24 }, { w: 640, h: 480 }, { width: 40, height: 20 }),
    { w: 40, h: 20 }
  );
  const byWidth = getFrameSize({ w: 80, h: 24 }, { w: 100, h: 100 }, { width: 50 });
  assert.equal(byWidth.w, 50);
  assert.ok(byWidth.h >= 1);
  const byHeight = getFrameSize({ w: 80, h: 24 }, { w: 100, h: 100 }, { height: 10 });
  assert.equal(byHeight.h, 10);
  assert.ok(byHeight.w >= 1);
});

test('getFrameSize rejects invalid input', () => {
  assert.throws(() => getFrameSize({ w: 0, h: 24 }, { w: 10, h: 10 }), /termSize/);
  assert.throws(() => getFrameSize({ w: 80, h: 24 }, { w: 10, h: 10 }, { width: -5 }), /width/);
  assert.throws(() => getFrameSize({ w: 80, h: 24 }, { w: 10, h: 10 }, { charAspect: 0 }), /charAspect/);
});
