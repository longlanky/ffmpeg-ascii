'use strict';

// Delta redraw for `play`: diff two cell grids (lib/ascii.js cellsFromBGRA)
// and emit cursor-addressed runs for changed cells only, instead of
// repainting the whole frame. Pure functions — unit testable, no ffmpeg.
//
// Rows/cols in emitted escape codes are 1-based (terminal convention).

const ANSI_RESET = '\x1b[0m';

function fgTruecolor(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgTruecolor(r, g, b) {
  return `\x1b[48;2;${r};${g};${b}m`;
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
 * { row, col, chars, colors[, bg] } (0-based origin, colors/bg = RGB
 * triples). A cell counts as changed when its glyph, fg, or bg differs;
 * grids whose bg presence differs count every cell changed.
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
  const bgMismatch = Boolean(prev.bg) !== Boolean(next.bg);
  const runs = [];
  let changed = 0;
  let run = null;

  const pushCell = (runObj, c) => {
    runObj.chars.push(next.chars[c]);
    runObj.colors.push(next.colors[c * 3], next.colors[c * 3 + 1], next.colors[c * 3 + 2]);
    if (next.bg) {
      runObj.bg.push(next.bg[c * 3], next.bg[c * 3 + 1], next.bg[c * 3 + 2]);
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y * width + x;
      let same = !bgMismatch && prev.chars[c] === next.chars[c];
      if (same) {
        same =
          prev.colors[c * 3] === next.colors[c * 3] &&
          prev.colors[c * 3 + 1] === next.colors[c * 3 + 1] &&
          prev.colors[c * 3 + 2] === next.colors[c * 3 + 2];
      }
      if (same && prev.bg && next.bg) {
        same =
          prev.bg[c * 3] === next.bg[c * 3] &&
          prev.bg[c * 3 + 1] === next.bg[c * 3 + 1] &&
          prev.bg[c * 3 + 2] === next.bg[c * 3 + 2];
      }
      if (same) {
        run = null;
        continue;
      }
      changed++;
      if (run && run.row === y && x === run.col + run.chars.length) {
        pushCell(run, c);
      } else {
        run = { row: y, col: x, chars: [], colors: [], bg: next.bg ? [] : null };
        pushCell(run, c);
        runs.push(run);
      }
    }
  }
  return { runs, changed, total };
}

/**
 * Stringify diff runs to terminal output: cursor-address each run, merge
 * SGR fg/bg codes across runs (terminal color state persists between
 * writes), single trailing full reset. Colored=false emits positioning +
 * glyphs only.
 */
function runsToAnsi(runs, colored = true) {
  const parts = [];
  let pr = -1;
  let pg = -1;
  let pb = -1;
  let qr = -1;
  let qg = -1;
  let qb = -1;
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
        if (run.bg) {
          const br = run.bg[k * 3];
          const bgg = run.bg[k * 3 + 1];
          const bb = run.bg[k * 3 + 2];
          if (br !== qr || bgg !== qg || bb !== qb) {
            parts.push(bgTruecolor(br, bgg, bb));
            qr = br;
            qg = bgg;
            qb = bb;
          }
        }
      }
      parts.push(run.chars[k]);
    }
  }
  const out = parts.join('');
  return colored && runs.length > 0 ? out + ANSI_RESET : out;
}

module.exports = { diffGrids, runsToAnsi };
