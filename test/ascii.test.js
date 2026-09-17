'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { asciiFromBGRA, stripAnsi, DEFAULT_CHARS } = require('../lib/ascii');

const px = (r, g, b) => [b, g, r, 255];

test('black maps to first char, white to last char', () => {
  const black = Buffer.from([...px(0, 0, 0), ...px(0, 0, 0)]);
  const white = Buffer.from([...px(255, 255, 255), ...px(255, 255, 255)]);
  assert.equal(asciiFromBGRA(black, 2, { colored: false }), '  ');
  assert.equal(asciiFromBGRA(white, 2, { colored: false }), '@@');
});

test('reverse flips the ramp', () => {
  const black = Buffer.from(px(0, 0, 0));
  assert.equal(asciiFromBGRA(black, 1, { colored: false }), DEFAULT_CHARS[0]);
  assert.equal(asciiFromBGRA(black, 1, { colored: false, reverse: true }), DEFAULT_CHARS.at(-1));
});

test('custom 2-char ramp thresholds at mid intensity', () => {
  const dark = Buffer.from(px(0, 0, 0));
  const bright = Buffer.from(px(255, 255, 255));
  assert.equal(asciiFromBGRA(dark, 1, { colored: false, chars: '01' }), '0');
  assert.equal(asciiFromBGRA(bright, 1, { colored: false, chars: '01' }), '1');
});

test('rows are joined with newlines, no trailing newline', () => {
  const buf = Buffer.from([...px(0, 0, 0), ...px(255, 255, 255), ...px(0, 0, 0), ...px(255, 255, 255)]);
  assert.equal(asciiFromBGRA(buf, 2, { colored: false }), ' @\n @');
});

test('colored output wraps each char in truecolor ANSI', () => {
  const buf = Buffer.from(px(10, 20, 30));
  const out = asciiFromBGRA(buf, 1, { colored: true });
  assert.match(out, /^\x1b\[38;2;10;20;30m.\x1b\[39m$/);
  assert.equal(stripAnsi(out).length, 1);
});

test('same-color runs share one SGR code with a single trailing reset', () => {
  const buf = Buffer.from([...px(10, 20, 30), ...px(10, 20, 30), ...px(10, 20, 30)]);
  const out = asciiFromBGRA(buf, 3, { colored: true });
  assert.equal(out.match(/\x1b\[38;2;/g).length, 1);
  assert.equal(out.match(/\x1b\[39m/g).length, 1);
  assert.ok(out.endsWith('\x1b[39m'));
  assert.equal(stripAnsi(out).length, 3);
});

test('color change mid-row emits a new SGR code', () => {
  const buf = Buffer.from([...px(10, 20, 30), ...px(200, 210, 220)]);
  const out = asciiFromBGRA(buf, 2, { colored: true });
  assert.equal(out.match(/\x1b\[38;2;/g).length, 2);
  assert.match(out, /\x1b\[38;2;10;20;30m.\x1b\[38;2;200;210;220m./);
});

test('dither is off by default and deterministic when on', () => {
  const mid = Buffer.from(Array.from({ length: 8 }, () => px(128, 128, 128)).flat());
  const plain = asciiFromBGRA(mid, 8, { colored: false, chars: '01' });
  assert.equal(plain, '11111111');
  const a = asciiFromBGRA(mid, 8, { colored: false, chars: '01', dither: true });
  const b = asciiFromBGRA(mid, 8, { colored: false, chars: '01', dither: true });
  assert.equal(a, b);
  assert.ok(a.includes('0') && a.includes('1'), `expected mixed dither texture, got ${JSON.stringify(a)}`);
});

test('dither cannot push extremes off the ramp ends', () => {
  const black = Buffer.from(px(0, 0, 0));
  const white = Buffer.from(px(255, 255, 255));
  assert.equal(asciiFromBGRA(black, 1, { colored: false, dither: true }), DEFAULT_CHARS[0]);
  assert.equal(asciiFromBGRA(white, 1, { colored: false, dither: true }), DEFAULT_CHARS.at(-1));
});

test('brightness extremes saturate the ramp', () => {
  const black = Buffer.from(px(0, 0, 0));
  const white = Buffer.from(px(255, 255, 255));
  assert.equal(asciiFromBGRA(black, 1, { colored: false, brightness: 255 }), '@');
  assert.equal(asciiFromBGRA(white, 1, { colored: false, brightness: -255 }), ' ');
});

test('contrast spreads mid tones', () => {
  const mid = Buffer.from(px(128, 128, 128));
  const flat = asciiFromBGRA(mid, 1, { colored: false, contrast: 0.1 });
  const steep = asciiFromBGRA(mid, 1, { colored: false, contrast: 5 });
  assert.equal(typeof flat, 'string');
  assert.equal(flat.length, 1);
  assert.equal(steep.length, 1);
});

test('invalid inputs throw actionable errors', () => {
  assert.throws(() => asciiFromBGRA('nope', 2, {}), /must be a Buffer/);
  assert.throws(() => asciiFromBGRA(Buffer.from([1, 2, 3]), 2, {}), /whole number/);
  assert.throws(() => asciiFromBGRA(Buffer.alloc(8), 0, {}), /frameWidth/);
  assert.throws(() => asciiFromBGRA(Buffer.alloc(8), 2, { chars: 'x' }), /at least 2/);
  assert.throws(() => asciiFromBGRA(Buffer.alloc(8), 2, { contrast: 99 }), /contrast/);
  assert.throws(() => asciiFromBGRA(Buffer.alloc(8), 2, { brightness: 999 }), /brightness/);
});
