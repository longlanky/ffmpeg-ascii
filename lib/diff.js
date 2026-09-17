'use strict';

// Delta redraw for `play`: diff two cell grids (lib/ascii.js cellsFromBGRA)
// and emit cursor-addressed runs for changed cells only, instead of
// repainting the whole frame. Pure functions — unit testable, no ffmpeg.
//
// Rows/cols in emitted escape codes are 1-based (terminal convention).

const ANSI_FG_RESET = '\x1b[39m';

function fgTruecolor(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function at(row1, col1) {
  return `\x1b[${row1};${col1}H`;
}

function sameDims(a, b) {
  return a.width === b.width && a.height === b.height;
}

/**
 * Diff two same-dimension grids into changed runs.
 * Returns { runs, changed, total } where each run is
 * { row, col, chars, colors } (0-based origin, colors = RGB triples Buffer).
 * Throws on dimension mismatch — the caller must full-redraw instead.
 */
function diffGrids(prev, next) {
  if (!sameDims(prev, next)) {
    throw new Error(
      `grid dimensions differ (${prev.width}x${prev.height} vs ${next.width}x${next.height}); full redraw required`
    );
  }
  const { width, height } = next;
  const total = width * height;
  const runs = [];
  let changed = 0;
  let run = null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y * width + x;
      const sameChar = prev.chars[c] === next.chars[c];
      const sameColor =
        prev.colors[c * 3] === next.colors[c * 3] &&
        prev.colors[c * 3 + 1] === next.colors[c * 3 + 1] &&
        prev.colors[c * 3 + 2] === next.colors[c * 3 + 2];
      if (sameChar && sameColor) {
        run = null;
        continue;
      }
      changed++;
      if (run && run.row === y && x === run.col + run.chars.length) {
        run.chars.push(next.chars[c]);
        run.colors.push(next.colors[c * 3], next.colors[c * 3 + 1], next.colors[c * 3 + 2]);
      } else {
        run = {
          row: y,
          col: x,
          chars: [next.chars[c]],
          colors: [next.colors[c * 3], next.colors[c * 3 + 1], next.colors[c * 3 + 2]],
        };
        runs.push(run);
      }
    }
  }
  return { runs, changed, total };
}

/**
 * Stringify diff runs to terminal output: cursor-address each run, merge
 * SGR color codes across runs (terminal fg state persists between writes),
 * single trailing reset. Colored=false emits positioning + glyphs only.
 */
function runsToAnsi(runs, colored = true) {
  const parts = [];
  let pr = -1;
  let pg = -1;
  let pb = -1;
  for (const run of runs) {
    parts.push(at(run.row + 1, run.col + 1));
    for (let k = 0; k < run.chars.length; k++) {
      if (colored) {
        const r = run.colors[k * 3];
        const g = run.colors[k * 3 + 1];
        const b = run.colors[k * 3 + 2];
        if (r !== pr || g !== pg || b !== pb) {
          parts.push(fgTruecolor(r, g, b));
          pr = r;
          pg = g;
          pb = b;
        }
      }
      parts.push(run.chars[k]);
    }
  }
  const out = parts.join('');
  return colored && runs.length > 0 ? out + ANSI_FG_RESET : out;
}

module.exports = { diffGrids, runsToAnsi };
