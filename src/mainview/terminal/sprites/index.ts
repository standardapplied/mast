/**
 * The sprite face: glyphs the terminal draws itself from cell geometry instead of the font, as
 * Ghostty does. Box drawing, block elements and braille only look right when they meet at the
 * exact cell edge — a font glyph designed for its own line height overshoots or undershoots our
 * cell, and an overshoot inside a shared atlas stamps stray pixels into its neighbours.
 */

import type { Raster } from "../raster";
import { BLOCK_FIRST, BLOCK_LAST, drawBlock } from "./block";
import { BOX_FIRST, BOX_LAST, drawBox } from "./box";
import { BRAILLE_FIRST, BRAILLE_LAST, drawBraille } from "./braille";
import type { SpriteDrawer, SpriteMetrics } from "./sprite";

export type { SpriteMetrics } from "./sprite";

const RANGES: readonly { first: number; last: number; draw: SpriteDrawer }[] = [
  { first: BOX_FIRST, last: BOX_LAST, draw: drawBox },
  { first: BLOCK_FIRST, last: BLOCK_LAST, draw: drawBlock },
  { first: BRAILLE_FIRST, last: BRAILLE_LAST, draw: drawBraille },
];

function drawerFor(cp: number): SpriteDrawer | null {
  for (const range of RANGES) {
    if (cp >= range.first && cp <= range.last) return range.draw;
  }
  return null;
}

/** The codepoint of a single-codepoint grapheme that the sprite face draws; null otherwise. */
export function spriteCodepoint(text: string): number | null {
  const cp = text.codePointAt(0);
  if (cp === undefined || String.fromCodePoint(cp) !== text) return null;
  return drawerFor(cp) ? cp : null;
}

/** Draws the sprite for {@code cp} into the cell-local rectangle of {@code r}. */
export function drawSprite(cp: number, r: Raster, m: SpriteMetrics): void {
  const draw = drawerFor(cp);
  if (!draw) {
    throw new Error(`drawSprite: U+${cp.toString(16)} has no sprite`);
  }
  draw(cp, r, m);
}
