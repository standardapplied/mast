/**
 * Braille Patterns, U+2800–U+28FF — a port of Ghostty's `font/sprite/draw/braille.zig`.
 *
 * The low byte of the codepoint is the dot pattern (bits 0–2 left column top→down, 3–5 right
 * column, 6–7 the bottom row), which is how spinners like ⠋⠙⠹ animate. Dot size, spacing and
 * margins are fitted to the cell so a 2×4 grid fills it evenly at any size.
 */

import type { Raster } from "../raster";
import { box, type SpriteMetrics } from "./sprite";

export const BRAILLE_FIRST = 0x2800;
export const BRAILLE_LAST = 0x28ff;

export function drawBraille(cp: number, r: Raster, m: SpriteMetrics): void {
  if (cp < BRAILLE_FIRST || cp > BRAILLE_LAST) {
    throw new Error(`drawBraille: U+${cp.toString(16)} is not a braille codepoint`);
  }
  const width = m.cellW;
  const height = m.cellH;

  let w = Math.min(Math.floor(width / 4), Math.floor(height / 8));
  let xSpacing = Math.floor(width / 4);
  let ySpacing = Math.floor(height / 8);
  let xMargin = Math.floor(xSpacing / 2);
  let yMargin = Math.floor(ySpacing / 2);
  let xLeft = width - 2 * xMargin - xSpacing - 2 * w;
  let yLeft = height - 2 * yMargin - 3 * ySpacing - 4 * w;

  if (xLeft >= 2 && yLeft >= 4 && w === 0) {
    w++;
    xLeft -= 2;
    yLeft -= 4;
  }
  if (xLeft >= 2 && xMargin === 0) {
    xMargin = 1;
    xLeft -= 2;
  }
  if (yLeft >= 2 && yMargin === 0) {
    yMargin = 1;
    yLeft -= 2;
  }
  if (xLeft >= 1) {
    xSpacing++;
    xLeft--;
  }
  if (yLeft >= 3) {
    ySpacing++;
    yLeft -= 3;
  }
  if (xLeft >= 2) {
    xMargin++;
    xLeft -= 2;
  }
  if (yLeft >= 2) {
    yMargin++;
    yLeft -= 2;
  }
  if (xLeft >= 2 && yLeft >= 4) {
    w++;
    xLeft -= 2;
    yLeft -= 4;
  }

  const x = [xMargin, xMargin + w + xSpacing];
  const y = [yMargin, 0, 0, 0];
  for (let i = 1; i < 4; i++) y[i] = y[i - 1]! + w + ySpacing;

  const dot = (col: number, row: number) => box(r, x[col]!, y[row]!, x[col]! + w, y[row]! + w);
  const bits = cp & 0xff;
  if (bits & 0x01) dot(0, 0);
  if (bits & 0x02) dot(0, 1);
  if (bits & 0x04) dot(0, 2);
  if (bits & 0x08) dot(1, 0);
  if (bits & 0x10) dot(1, 1);
  if (bits & 0x20) dot(1, 2);
  if (bits & 0x40) dot(0, 3);
  if (bits & 0x80) dot(1, 3);
}
