'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cellsFromBGRA, halfCellsFromBGRA, stripAnsi } = require('../lib/ascii');
const { diffGrids, runsToAnsi } = require('../lib/diff');

const px = (r, g, b) => [b, g, r, 255];
const frame = (pixels, w) => Buffer.from(pixels.flatMap(([r, g, b]) => px(r, g, b)));

function grid(pixels, w, opts) {
  return cellsFromBGRA(frame(pixels, w), w, { colored: false, ...opts });
}

test('identical grids diff to zero runs', () => {
  const a = grid([[0, 0, 0], [255, 255, 255]], 2);
  const d = diffGrids(a, grid([[0, 0, 0], [255, 255, 255]], 2));
  assert.equal(d.changed, 0);
  assert.equal(d.total, 2);
  assert.deepEqual(d.runs, []);
  assert.equal(runsToAnsi(d.runs), '');
});

test('single-cell change yields one addressed run', () => {
  const a = grid([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], 2);
  const b = grid([[0, 0, 0], [0, 0, 0], [0, 0, 0], [255, 255, 255]], 2);
  const d = diffGrids(a, b);
  assert.equal(d.changed, 1);
  assert.equal(d.runs.length, 1);
  assert.deepEqual([d.runs[0].row, d.runs[0].col], [1, 1]);
  const out = runsToAnsi(d.runs, false);
  assert.ok(out.startsWith('\x1b[2;2H'), JSON.stringify(out));
  assert.equal(stripAnsi(out), '@');
});

test('contiguous changes merge, gaps split runs', () => {
  const dark = [0, 0, 0];
  const lite = [255, 255, 255];
  const a = grid([dark, dark, dark, dark, dark], 5);
  const b = grid([lite, lite, dark, lite, lite], 5);
  const d = diffGrids(a, b);
  assert.equal(d.changed, 4);
  assert.equal(d.runs.length, 2);
  assert.deepEqual([d.runs[0].col, d.runs[0].chars.length], [0, 2]);
  assert.deepEqual([d.runs[1].col, d.runs[1].chars.length], [3, 2]);
});

test('color-only change is detected', () => {
  // Same luminance (r+g+b equal) but different hue: same glyph, new color.
  const a = cellsFromBGRA(frame([[100, 100, 100]]), 1, {});
  const b = cellsFromBGRA(frame([[200, 50, 50]]), 1, {});
  assert.equal(a.chars[0], b.chars[0]);
  const d = diffGrids(a, b);
  assert.equal(d.changed, 1);
  const out = runsToAnsi(d.runs, true);
  assert.match(out, /\x1b\[38;2;200;50;50m/);
  assert.ok(out.endsWith('\x1b[0m'));
});

test('runs reconstruct the next frame (randomized roundtrip)', () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 256;
  };
  for (let t = 0; t < 20; t++) {
    const w = 1 + Math.floor(rnd() / 32);
    const h = 1 + Math.floor(rnd() / 64);
    const mk = () => Array.from({ length: w * h }, () => [rnd(), rnd(), rnd()]);
    const a = grid(mk(), w);
    const b = grid(mk(), w);
    const d = diffGrids(a, b);
    // Replay runs onto a copy of prev.
    const replay = { chars: [...a.chars], colors: Buffer.from(a.colors), width: w, height: h };
    for (const run of d.runs) {
      for (let k = 0; k < run.chars.length; k++) {
        const c = run.row * w + run.col + k;
        replay.chars[c] = run.chars[k];
        replay.colors[c * 3] = run.colors[k * 3];
        replay.colors[c * 3 + 1] = run.colors[k * 3 + 1];
        replay.colors[c * 3 + 2] = run.colors[k * 3 + 2];
      }
    }
    assert.deepEqual(replay.chars, b.chars);
    assert.deepEqual(replay.colors, b.colors);
    const expectChanged = b.chars.filter((c, i) => {
      return (
        c !== a.chars[i] ||
        b.colors[i * 3] !== a.colors[i * 3] ||
        b.colors[i * 3 + 1] !== a.colors[i * 3 + 1] ||
        b.colors[i * 3 + 2] !== a.colors[i * 3 + 2]
      );
    }).length;
    assert.equal(d.changed, expectChanged);
  }
});

test('dimension mismatch throws (caller must full-redraw)', () => {
  const a = grid([[0, 0, 0]], 1);
  const b = grid([[0, 0, 0], [0, 0, 0]], 2);
  assert.throws(() => diffGrids(a, b), /full redraw required/);
});

test('bg-only change is detected and re-emitted', () => {
  const top = [...px(10, 10, 10)];
  const mk = (b) => halfCellsFromBGRA(Buffer.from([...top, ...px(...b)]), 1);
  const a = mk([0, 0, 0]);
  const b = mk([200, 0, 0]);
  const d = diffGrids(a, b);
  assert.equal(d.changed, 1);
  const out = runsToAnsi(d.runs, true);
  assert.match(out, /\x1b\[48;2;200;0;0m/);
  assert.ok(out.endsWith('\x1b[0m'));
  assert.equal(stripAnsi(out), '▀');
});

test('bg presence mismatch counts every cell changed', () => {
  const a = grid([[0, 0, 0], [0, 0, 0]], 2);
  const b = halfCellsFromBGRA(
    Buffer.from([...px(0, 0, 0), ...px(0, 0, 0), ...px(0, 0, 0), ...px(0, 0, 0)]),
    2
  );
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const d = diffGrids(a, b);
  assert.equal(d.changed, d.total);
});

test('half-block grids roundtrip through runs', () => {
  const mk = (v) =>
    halfCellsFromBGRA(
      Buffer.from([v, v, v, 255, 255 - v, 0, v, 255, v, v, v, 255, 0, v, 255, 255]),
      2
    );
  const a = mk(10);
  const b = mk(200);
  const d = diffGrids(a, b);
  assert.ok(d.changed > 0);
  const out = runsToAnsi(d.runs, true);
  assert.equal(stripAnsi(out).replace(/\x1b\[[0-9;]*H/g, ''), '▀▀');
});
