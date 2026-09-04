import type { Raster } from "../raster";

/** The cell geometry a sprite is drawn for, in integer device pixels. */
export interface SpriteMetrics {
  readonly cellW: number;
  readonly cellH: number;
  /** Stroke width of a light line; heavy lines are twice this. */
  readonly boxThickness: number;
}

/** Draws one codepoint's sprite into the cell-local rectangle (0,0)–(cellW,cellH) of {@code r}. */
export type SpriteDrawer = (cp: number, r: Raster, m: SpriteMetrics) => void;

/** Fills the integer box (x0,y0)–(x1,y1); an empty or inverted box draws nothing. */
export function box(r: Raster, x0: number, y0: number, x1: number, y1: number): void {
  if (x1 > x0 && y1 > y0) {
    r.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}

/** Saturating subtraction, the way Ghostty's `-|` on unsigned metrics behaves. */
export function sub(a: number, b: number): number {
  return Math.max(0, a - b);
}

export const LIGHT = 1;
export const HEAVY = 2;

/** Ghostty's `Thickness.height`: the pixel height of a stroke of the given weight. */
export function strokePx(weight: typeof LIGHT | typeof HEAVY, boxThickness: number): number {
  return boxThickness * weight;
}
