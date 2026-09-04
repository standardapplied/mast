/**
 * Block Elements, U+2580–U+259F — a port of Ghostty's `font/sprite/draw/block.zig`.
 *
 * ▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏ ▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟
 *
 * Fractions are rounded against the cell so complementary blocks (▀ over ▄, ▌ beside ▐) tile
 * without a seam; shades are drawn as translucent full cells since the atlas is white-on-alpha.
 */

import type { Raster } from "../raster";
import { box, type SpriteMetrics } from "./sprite";

type Horizontal = "left" | "right" | "center";
type Vertical = "top" | "bottom" | "middle";

interface Quads {
  readonly tl?: boolean;
  readonly tr?: boolean;
  readonly bl?: boolean;
  readonly br?: boolean;
}

/** Ghostty's `Shade`: alpha of a shaded full block. */
const SHADE = { light: 0x40, medium: 0x80, dark: 0xc0 } as const;

type Draw = (r: Raster, m: SpriteMetrics) => void;

const block =
  (horizontal: Horizontal, vertical: Vertical, width: number, height: number): Draw =>
  (r, m) => {
    const w = Math.round(m.cellW * width);
    const h = Math.round(m.cellH * height);
    const x =
      horizontal === "left" ? 0 : horizontal === "right" ? m.cellW - w : Math.floor((m.cellW - w) / 2);
    const y =
      vertical === "top" ? 0 : vertical === "bottom" ? m.cellH - h : Math.floor((m.cellH - h) / 2);
    box(r, x, y, x + w, y + h);
  };

const shade =
  (alpha: number): Draw =>
  (r, m) => {
    const previous = r.fillStyle;
    r.fillStyle = `rgba(255,255,255,${(alpha / 255).toFixed(3)})`;
    box(r, 0, 0, m.cellW, m.cellH);
    r.fillStyle = previous;
  };

/** Ghostty's `Fraction.min`/`max`: the pixel edges of a fractional span, rounded to tile seamlessly. */
const fracMin = (f: number, size: number) => size - Math.round((1 - f) * size);
const fracMax = (f: number, size: number) => Math.round(f * size);

const quadrant =
  (q: Quads): Draw =>
  (r, m) => {
    const fill = (x0: number, x1: number, y0: number, y1: number) =>
      box(
        r,
        fracMin(x0, m.cellW),
        fracMin(y0, m.cellH),
        fracMax(x1, m.cellW),
        fracMax(y1, m.cellH),
      );
    if (q.tl) fill(0, 0.5, 0, 0.5);
    if (q.tr) fill(0.5, 1, 0, 0.5);
    if (q.bl) fill(0, 0.5, 0.5, 1);
    if (q.br) fill(0.5, 1, 0.5, 1);
  };

/** Indexed by codepoint − 0x2580, in Unicode order. */
const TABLE: readonly Draw[] = [
  block("center", "top", 1, 1 / 2), // ▀
  block("center", "bottom", 1, 1 / 8), // ▁
  block("center", "bottom", 1, 1 / 4), // ▂
  block("center", "bottom", 1, 3 / 8), // ▃
  block("center", "bottom", 1, 1 / 2), // ▄
  block("center", "bottom", 1, 5 / 8), // ▅
  block("center", "bottom", 1, 3 / 4), // ▆
  block("center", "bottom", 1, 7 / 8), // ▇
  block("left", "top", 1, 1), // █
  block("left", "middle", 7 / 8, 1), // ▉
  block("left", "middle", 3 / 4, 1), // ▊
  block("left", "middle", 5 / 8, 1), // ▋
  block("left", "middle", 1 / 2, 1), // ▌
  block("left", "middle", 3 / 8, 1), // ▍
  block("left", "middle", 1 / 4, 1), // ▎
  block("left", "middle", 1 / 8, 1), // ▏
  block("right", "middle", 1 / 2, 1), // ▐
  shade(SHADE.light), // ░
  shade(SHADE.medium), // ▒
  shade(SHADE.dark), // ▓
  block("center", "top", 1, 1 / 8), // ▔
  block("right", "middle", 1 / 8, 1), // ▕
  quadrant({ bl: true }), // ▖
  quadrant({ br: true }), // ▗
  quadrant({ tl: true }), // ▘
  quadrant({ tl: true, bl: true, br: true }), // ▙
  quadrant({ tl: true, br: true }), // ▚
  quadrant({ tl: true, tr: true, bl: true }), // ▛
  quadrant({ tl: true, tr: true, br: true }), // ▜
  quadrant({ tr: true }), // ▝
  quadrant({ tr: true, bl: true }), // ▞
  quadrant({ tr: true, bl: true, br: true }), // ▟
];

export const BLOCK_FIRST = 0x2580;
export const BLOCK_LAST = 0x259f;

export function drawBlock(cp: number, r: Raster, m: SpriteMetrics): void {
  const draw = TABLE[cp - BLOCK_FIRST];
  if (!draw) {
    throw new Error(`drawBlock: U+${cp.toString(16)} is not a block-element codepoint`);
  }
  draw(r, m);
}
