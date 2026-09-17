'use strict';

// Direct BGRA -> ASCII renderer (zero dependencies).
// Intensity model matches the legacy asciify-pixel behavior:
//   value = r + g + b (alpha treated as opaque), range 0..765,
//   char = chars[round(value / (765 / (chars.length - 1)))].

const DEFAULT_CHARS = ' .,:;i1tfLCG08@';
const ANSI_FG_RESET = '\x1b[39m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// 4x4 Bayer threshold map, values 0..15.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

function fgTruecolor(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
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
  const colored = options.colored !== false;
  const dither = options.dither === true;
  const brightnessOffset = brightness * 3;
  const useAdjust = contrast !== 1 || brightnessOffset !== 0;

  const rows = new Array(frameHeight);
  let pr = -1;
  let pg = -1;
  let pb = -1;
  for (let y = 0; y < frameHeight; y++) {
    const rowBase = y * bytesPerRow;
    const parts = [];
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
      const ch = ramp[Math.round(value / precision)];
      if (colored) {
        if (r !== pr || g !== pg || b !== pb) {
          parts.push(fgTruecolor(r, g, b));
          pr = r;
          pg = g;
          pb = b;
        }
        parts.push(ch);
      } else {
        parts.push(ch);
      }
    }
    rows[y] = parts.join('');
  }
  const out = rows.join('\n');
  return colored ? out + ANSI_FG_RESET : out;
}

module.exports = { asciiFromBGRA, stripAnsi, DEFAULT_CHARS };
