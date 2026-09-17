'use strict';

// Direct BGRA -> ASCII renderer (zero dependencies).
// Intensity model matches the legacy asciify-pixel behavior:
//   value = r + g + b (alpha treated as opaque), range 0..765,
//   char = chars[round(value / (765 / (chars.length - 1)))].

const DEFAULT_CHARS = ' .,:;i1tfLCG08@';
// Full reset (fg+bg): diff runs and half-block cells can set background color.
const ANSI_RESET = '\x1b[0m';
// SGR color codes + CUP cursor-addressing (emitted by lib/diff.js runs).
const ANSI_RE = /\x1b\[[0-9;]*[mH]/g;
// 4x4 Bayer threshold map, values 0..15.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// Upper half-block: fg paints the top pixel, bg the bottom pixel.
const HALF_BLOCK = '▀';

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

function fgTruecolor(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgTruecolor(r, g, b) {
  return `\x1b[48;2;${r};${g};${b}m`;
}

function validateRenderOptions(frameWidth, options) {
  if (!Number.isInteger(frameWidth) || frameWidth <= 0) {
    throw new Error(`frameWidth must be a positive integer (got ${frameWidth})`);
  }
  const o = options || {};
  const chars = o.chars == null ? DEFAULT_CHARS : String(o.chars);
  if (chars.length < 2) {
    throw new Error('chars must contain at least 2 characters');
  }
  const contrast = o.contrast == null ? 1 : Number(o.contrast);
  if (!Number.isFinite(contrast) || contrast <= 0 || contrast > 5) {
    throw new Error(`contrast must be in (0, 5] (got ${o.contrast})`);
  }
  const brightness = o.brightness == null ? 0 : Number(o.brightness);
  if (!Number.isFinite(brightness) || brightness < -255 || brightness > 255) {
    throw new Error(`brightness must be in -255..255 (got ${o.brightness})`);
  }
  return { chars, contrast, brightness };
}

/**
 * Render one full BGRA frame to a cell grid: flat char array (row-major)
 * plus RGB triples. The grid is what diffing (lib/diff.js) operates on;
 * use cellsToString() for display text. One pass, no per-pixel objects.
 *
 * options: { chars, reverse, contrast, brightness, dither } (no `colored`;
 * color is a stringification concern). Returns { chars, colors, width, height }.
 */
function cellsFromBGRA(bgra, frameWidth, options = {}) {
  if (!Buffer.isBuffer(bgra)) {
    throw new Error('bgra must be a Buffer');
  }
  const { chars, contrast, brightness } = validateRenderOptions(frameWidth, options);
  const bytesPerRow = frameWidth * 4;
  if (bgra.length === 0 || bgra.length % bytesPerRow !== 0) {
    throw new Error(
      `bgra length ${bgra.length} is not a whole number of ${frameWidth}-pixel rows`
    );
  }
  const frameHeight = bgra.length / bytesPerRow;

  const ramp = options.reverse ? [...chars].reverse().join('') : chars;
  const precision = 765 / (ramp.length - 1);
  const dither = options.dither === true;
  const brightnessOffset = brightness * 3;
  const useAdjust = contrast !== 1 || brightnessOffset !== 0;

  const cellChars = new Array(frameWidth * frameHeight);
  const colors = Buffer.alloc(frameWidth * frameHeight * 3);
  for (let y = 0; y < frameHeight; y++) {
    const rowBase = y * bytesPerRow;
    for (let x = 0; x < frameWidth; x++) {
      const i = rowBase + x * 4;
      const b = bgra[i];
      const g = bgra[i + 1];
      const r = bgra[i + 2];
      let value = r + g + b;
      if (useAdjust) {
        value = (value - 382.5) * contrast + 382.5 + brightnessOffset;
        if (value < 0) value = 0;
        else if (value > 765) value = 765;
      }
      if (dither) {
        const t = ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * precision;
        value += t;
        if (value < 0) value = 0;
        else if (value > 765) value = 765;
      }
      const c = y * frameWidth + x;
      cellChars[c] = ramp[Math.round(value / precision)];
      colors[c * 3] = r;
      colors[c * 3 + 1] = g;
      colors[c * 3 + 2] = b;
    }
  }
  return { chars: cellChars, colors, width: frameWidth, height: frameHeight };
}

/**
 * Stringify a cell grid to display text (rows joined by "\n", no trailing
 * newline). Colored output emits one SGR per same-color run plus a single
 * trailing full reset — identical visuals to per-char codes, fewer bytes.
 * Grids with a `bg` layer (half-block mode) also merge background codes.
 */
function cellsToString(grid, colored = true) {
  const { chars, colors, bg, width, height } = grid;
  const rows = new Array(height);
  let pr = -1;
  let pg = -1;
  let pb = -1;
  let qr = -1;
  let qg = -1;
  let qb = -1;
  for (let y = 0; y < height; y++) {
    const parts = [];
    for (let x = 0; x < width; x++) {
      const c = y * width + x;
      if (colored) {
        const r = colors[c * 3];
        const g = colors[c * 3 + 1];
        const b = colors[c * 3 + 2];
        if (r !== pr || g !== pg || b !== pb) {
          parts.push(fgTruecolor(r, g, b));
          pr = r;
          pg = g;
          pb = b;
        }
        if (bg) {
          const br = bg[c * 3];
          const bgg = bg[c * 3 + 1];
          const bb = bg[c * 3 + 2];
          if (br !== qr || bgg !== qg || bb !== qb) {
            parts.push(bgTruecolor(br, bgg, bb));
            qr = br;
            qg = bgg;
            qb = bb;
          }
        }
      }
      parts.push(chars[c]);
    }
    rows[y] = parts.join('');
  }
  const out = rows.join('\n');
  return colored ? out + ANSI_RESET : out;
}

/**
 * Hi-density grid: pair two vertical pixels per cell using the upper
 * half-block (fg = top pixel, bg = bottom pixel) — 2x vertical resolution
 * at the same character size. Grid height is ceil(pixelRows / 2); a dangling
 * odd row pairs with itself. Colors are raw RGB: chars/contrast/dither
 * options do not apply (documented on the --half-blocks flag).
 */
function halfCellsFromBGRA(bgra, frameWidth) {
  if (!Buffer.isBuffer(bgra)) {
    throw new Error('bgra must be a Buffer');
  }
  if (!Number.isInteger(frameWidth) || frameWidth <= 0) {
    throw new Error(`frameWidth must be a positive integer (got ${frameWidth})`);
  }
  const bytesPerRow = frameWidth * 4;
  if (bgra.length === 0 || bgra.length % bytesPerRow !== 0) {
    throw new Error(
      `bgra length ${bgra.length} is not a whole number of ${frameWidth}-pixel rows`
    );
  }
  const pixelRows = bgra.length / bytesPerRow;
  const height = Math.ceil(pixelRows / 2);
  const chars = new Array(frameWidth * height).fill(HALF_BLOCK);
  const colors = Buffer.alloc(frameWidth * height * 3);
  const bg = Buffer.alloc(frameWidth * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const top = (y * 2 * frameWidth + x) * 4;
      const hasBottom = y * 2 + 1 < pixelRows;
      const bot = hasBottom ? ((y * 2 + 1) * frameWidth + x) * 4 : top;
      const c = y * frameWidth + x;
      colors[c * 3] = bgra[top + 2];
      colors[c * 3 + 1] = bgra[top + 1];
      colors[c * 3 + 2] = bgra[top];
      bg[c * 3] = bgra[bot + 2];
      bg[c * 3 + 1] = bgra[bot + 1];
      bg[c * 3 + 2] = bgra[bot];
    }
  }
  return { chars, colors, bg, width: frameWidth, height };
}

/**
 * Render one full BGRA frame to an ASCII string (rows joined by "\n",
 * no trailing newline). One pass, no per-pixel object allocation.
 *
 * options: { chars, colored=true, reverse=false, contrast=1, brightness=0, dither=false }
 *   - brightness is a per-channel offset (-255..255), applied as offset*3
 *     to the 0..765 intensity range.
 *   - dither applies 4x4 Bayer ordered dithering (±half a ramp step) before
 *     quantization, trading banding for texture. Deterministic.
 *   - colored output emits one truecolor SGR per same-color run (not per
 *     char) plus a single trailing reset — identical visuals, fewer bytes.
 */
function asciiFromBGRA(bgra, frameWidth, options = {}) {
  const grid = cellsFromBGRA(bgra, frameWidth, options);
  return cellsToString(grid, options.colored !== false);
}

module.exports = { asciiFromBGRA, cellsFromBGRA, halfCellsFromBGRA, cellsToString, stripAnsi, DEFAULT_CHARS };
