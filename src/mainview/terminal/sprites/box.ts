/**
 * Box Drawing, U+2500–U+257F — a port of Ghostty's `font/sprite/draw/box.zig`.
 *
 * ─━│┃┄┅┆┇┈┉┊┋┌┍┎┏ ┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟ ┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯ ┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿
 * ╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏ ═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟ ╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯ ╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿
 *
 * Every glyph is laid out from the cell metrics, so lines meet their neighbours exactly at the
 * cell edge and a run of them reads as one continuous stroke — what a font glyph, designed for its
 * own line height, cannot guarantee inside our cell.
 */

import type { Raster } from "../raster";
import { box, HEAVY, LIGHT, type SpriteMetrics, strokePx, sub } from "./sprite";

const NONE = 0;
const DOUBLE = 3;
type Style = typeof NONE | typeof LIGHT | typeof HEAVY | typeof DOUBLE;

/** Line style from each edge to the center. */
interface Lines {
  readonly up: Style;
  readonly right: Style;
  readonly down: Style;
  readonly left: Style;
}

const L = LIGHT;
const H = HEAVY;
const D = DOUBLE;
const lines = (up: Style, right: Style, down: Style, left: Style): Lines => ({
  up,
  right,
  down,
  left,
});

type Corner = "tl" | "tr" | "bl" | "br";

type Draw = (r: Raster, m: SpriteMetrics) => void;

const linesChar =
  (l: Lines): Draw =>
  (r, m) =>
    drawLines(r, m, l);
type Weight = typeof LIGHT | typeof HEAVY;
const dashH =
  (count: number, weight: Weight, gapWeight: Weight, minGap: number): Draw =>
  (r, m) => {
    const gap = Math.max(minGap, strokePx(gapWeight, m.boxThickness));
    dashHorizontal(r, m, count, strokePx(weight, m.boxThickness), gap);
  };
const dashV =
  (count: number, weight: Weight, gapWeight: Weight, minGap: number): Draw =>
  (r, m) => {
    const gap = Math.max(minGap, strokePx(gapWeight, m.boxThickness));
    dashVertical(r, m, count, strokePx(weight, m.boxThickness), gap);
  };
const arcChar =
  (corner: Corner): Draw =>
  (r, m) =>
    arc(r, m, corner);

/** Indexed by codepoint − 0x2500, in Unicode order. */
const TABLE: readonly Draw[] = [
  linesChar(lines(0, L, 0, L)), // ─
  linesChar(lines(0, H, 0, H)), // ━
  linesChar(lines(L, 0, L, 0)), // │
  linesChar(lines(H, 0, H, 0)), // ┃
  dashH(3, L, L, 4), // ┄
  dashH(3, H, L, 4), // ┅
  dashV(3, L, L, 4), // ┆
  dashV(3, H, L, 4), // ┇
  dashH(4, L, L, 4), // ┈
  dashH(4, H, L, 4), // ┉
  dashV(4, L, L, 4), // ┊
  dashV(4, H, L, 4), // ┋
  linesChar(lines(0, L, L, 0)), // ┌
  linesChar(lines(0, H, L, 0)), // ┍
  linesChar(lines(0, L, H, 0)), // ┎
  linesChar(lines(0, H, H, 0)), // ┏
  linesChar(lines(0, 0, L, L)), // ┐
  linesChar(lines(0, 0, L, H)), // ┑
  linesChar(lines(0, 0, H, L)), // ┒
  linesChar(lines(0, 0, H, H)), // ┓
  linesChar(lines(L, L, 0, 0)), // └
  linesChar(lines(L, H, 0, 0)), // ┕
  linesChar(lines(H, L, 0, 0)), // ┖
  linesChar(lines(H, H, 0, 0)), // ┗
  linesChar(lines(L, 0, 0, L)), // ┘
  linesChar(lines(L, 0, 0, H)), // ┙
  linesChar(lines(H, 0, 0, L)), // ┚
  linesChar(lines(H, 0, 0, H)), // ┛
  linesChar(lines(L, L, L, 0)), // ├
  linesChar(lines(L, H, L, 0)), // ┝
  linesChar(lines(H, L, L, 0)), // ┞
  linesChar(lines(L, L, H, 0)), // ┟
  linesChar(lines(H, L, H, 0)), // ┠
  linesChar(lines(H, H, L, 0)), // ┡
  linesChar(lines(L, H, H, 0)), // ┢
  linesChar(lines(H, H, H, 0)), // ┣
  linesChar(lines(L, 0, L, L)), // ┤
  linesChar(lines(L, 0, L, H)), // ┥
  linesChar(lines(H, 0, L, L)), // ┦
  linesChar(lines(L, 0, H, L)), // ┧
  linesChar(lines(H, 0, H, L)), // ┨
  linesChar(lines(H, 0, L, H)), // ┩
  linesChar(lines(L, 0, H, H)), // ┪
  linesChar(lines(H, 0, H, H)), // ┫
  linesChar(lines(0, L, L, L)), // ┬
  linesChar(lines(0, L, L, H)), // ┭
  linesChar(lines(0, H, L, L)), // ┮
  linesChar(lines(0, H, L, H)), // ┯
  linesChar(lines(0, L, H, L)), // ┰
  linesChar(lines(0, L, H, H)), // ┱
  linesChar(lines(0, H, H, L)), // ┲
  linesChar(lines(0, H, H, H)), // ┳
  linesChar(lines(L, L, 0, L)), // ┴
  linesChar(lines(L, L, 0, H)), // ┵
  linesChar(lines(L, H, 0, L)), // ┶
  linesChar(lines(L, H, 0, H)), // ┷
  linesChar(lines(H, L, 0, L)), // ┸
  linesChar(lines(H, L, 0, H)), // ┹
  linesChar(lines(H, H, 0, L)), // ┺
  linesChar(lines(H, H, 0, H)), // ┻
  linesChar(lines(L, L, L, L)), // ┼
  linesChar(lines(L, L, L, H)), // ┽
  linesChar(lines(L, H, L, L)), // ┾
  linesChar(lines(L, H, L, H)), // ┿
  linesChar(lines(H, L, L, L)), // ╀
  linesChar(lines(L, L, H, L)), // ╁
  linesChar(lines(H, L, H, L)), // ╂
  linesChar(lines(H, L, L, H)), // ╃
  linesChar(lines(H, H, L, L)), // ╄
  linesChar(lines(L, L, H, H)), // ╅
  linesChar(lines(L, H, H, L)), // ╆
  linesChar(lines(H, H, L, H)), // ╇
  linesChar(lines(L, H, H, H)), // ╈
  linesChar(lines(H, L, H, H)), // ╉
  linesChar(lines(H, H, H, L)), // ╊
  linesChar(lines(H, H, H, H)), // ╋
  dashH(2, L, L, 0), // ╌
  dashH(2, H, H, 0), // ╍
  dashV(2, L, H, 0), // ╎
  dashV(2, H, H, 0), // ╏
  linesChar(lines(0, D, 0, D)), // ═
  linesChar(lines(D, 0, D, 0)), // ║
  linesChar(lines(0, D, L, 0)), // ╒
  linesChar(lines(0, L, D, 0)), // ╓
  linesChar(lines(0, D, D, 0)), // ╔
  linesChar(lines(0, 0, L, D)), // ╕
  linesChar(lines(0, 0, D, L)), // ╖
  linesChar(lines(0, 0, D, D)), // ╗
  linesChar(lines(L, D, 0, 0)), // ╘
  linesChar(lines(D, L, 0, 0)), // ╙
  linesChar(lines(D, D, 0, 0)), // ╚
  linesChar(lines(L, 0, 0, D)), // ╛
  linesChar(lines(D, 0, 0, L)), // ╜
  linesChar(lines(D, 0, 0, D)), // ╝
  linesChar(lines(L, D, L, 0)), // ╞
  linesChar(lines(D, L, D, 0)), // ╟
  linesChar(lines(D, D, D, 0)), // ╠
  linesChar(lines(L, 0, L, D)), // ╡
  linesChar(lines(D, 0, D, L)), // ╢
  linesChar(lines(D, 0, D, D)), // ╣
  linesChar(lines(0, D, L, D)), // ╤
  linesChar(lines(0, L, D, L)), // ╥
  linesChar(lines(0, D, D, D)), // ╦
  linesChar(lines(L, D, 0, D)), // ╧
  linesChar(lines(D, L, 0, L)), // ╨
  linesChar(lines(D, D, 0, D)), // ╩
  linesChar(lines(L, D, L, D)), // ╪
  linesChar(lines(D, L, D, L)), // ╫
  linesChar(lines(D, D, D, D)), // ╬
  arcChar("br"), // ╭
  arcChar("bl"), // ╮
  arcChar("tl"), // ╯
  arcChar("tr"), // ╰
  (r, m) => diagonal(r, m, "upperRightToLowerLeft"), // ╱
  (r, m) => diagonal(r, m, "upperLeftToLowerRight"), // ╲
  (r, m) => {
    diagonal(r, m, "upperRightToLowerLeft");
    diagonal(r, m, "upperLeftToLowerRight");
  }, // ╳
  linesChar(lines(0, 0, 0, L)), // ╴
  linesChar(lines(L, 0, 0, 0)), // ╵
  linesChar(lines(0, L, 0, 0)), // ╶
  linesChar(lines(0, 0, L, 0)), // ╷
  linesChar(lines(0, 0, 0, H)), // ╸
  linesChar(lines(H, 0, 0, 0)), // ╹
  linesChar(lines(0, H, 0, 0)), // ╺
  linesChar(lines(0, 0, H, 0)), // ╻
  linesChar(lines(0, H, 0, L)), // ╼
  linesChar(lines(L, 0, H, 0)), // ╽
  linesChar(lines(0, L, 0, H)), // ╾
  linesChar(lines(H, 0, L, 0)), // ╿
];

export const BOX_FIRST = 0x2500;
export const BOX_LAST = 0x257f;

export function drawBox(cp: number, r: Raster, m: SpriteMetrics): void {
  const draw = TABLE[cp - BOX_FIRST];
  if (!draw) {
    throw new Error(`drawBox: U+${cp.toString(16)} is not a box-drawing codepoint`);
  }
  draw(r, m);
}

/** Ghostty's `linesChar`: each edge's stroke runs from the cell edge to where it meets the others. */
function drawLines(r: Raster, m: SpriteMetrics, l: Lines): void {
  const lightPx = strokePx(LIGHT, m.boxThickness);
  const heavyPx = strokePx(HEAVY, m.boxThickness);

  const hLightTop = Math.floor(sub(m.cellH, lightPx) / 2);
  const hLightBottom = hLightTop + lightPx;
  const hHeavyTop = Math.floor(sub(m.cellH, heavyPx) / 2);
  const hHeavyBottom = hHeavyTop + heavyPx;
  const hDoubleTop = sub(hLightTop, lightPx);
  const hDoubleBottom = hLightBottom + lightPx;

  const vLightLeft = Math.floor(sub(m.cellW, lightPx) / 2);
  const vLightRight = vLightLeft + lightPx;
  const vHeavyLeft = Math.floor(sub(m.cellW, heavyPx) / 2);
  const vHeavyRight = vHeavyLeft + heavyPx;
  const vDoubleLeft = sub(vLightLeft, lightPx);
  const vDoubleRight = vLightRight + lightPx;

  const upBottom =
    l.left === HEAVY || l.right === HEAVY
      ? hHeavyBottom
      : l.left !== l.right || l.down === l.up
        ? l.left === DOUBLE || l.right === DOUBLE
          ? hDoubleBottom
          : hLightBottom
        : l.left === NONE && l.right === NONE
          ? hLightBottom
          : hLightTop;

  const downTop =
    l.left === HEAVY || l.right === HEAVY
      ? hHeavyTop
      : l.left !== l.right || l.up === l.down
        ? l.left === DOUBLE || l.right === DOUBLE
          ? hDoubleTop
          : hLightTop
        : l.left === NONE && l.right === NONE
          ? hLightTop
          : hLightBottom;

  const leftRight =
    l.up === HEAVY || l.down === HEAVY
      ? vHeavyRight
      : l.up !== l.down || l.left === l.right
        ? l.up === DOUBLE || l.down === DOUBLE
          ? vDoubleRight
          : vLightRight
        : l.up === NONE && l.down === NONE
          ? vLightRight
          : vLightLeft;

  const rightLeft =
    l.up === HEAVY || l.down === HEAVY
      ? vHeavyLeft
      : l.up !== l.down || l.right === l.left
        ? l.up === DOUBLE || l.down === DOUBLE
          ? vDoubleLeft
          : vLightLeft
        : l.up === NONE && l.down === NONE
          ? vLightLeft
          : vLightRight;

  switch (l.up) {
    case LIGHT:
      box(r, vLightLeft, 0, vLightRight, upBottom);
      break;
    case HEAVY:
      box(r, vHeavyLeft, 0, vHeavyRight, upBottom);
      break;
    case DOUBLE: {
      const leftBottom = l.left === DOUBLE ? hLightTop : upBottom;
      const rightBottom = l.right === DOUBLE ? hLightTop : upBottom;
      box(r, vDoubleLeft, 0, vLightLeft, leftBottom);
      box(r, vLightRight, 0, vDoubleRight, rightBottom);
      break;
    }
  }

  switch (l.right) {
    case LIGHT:
      box(r, rightLeft, hLightTop, m.cellW, hLightBottom);
      break;
    case HEAVY:
      box(r, rightLeft, hHeavyTop, m.cellW, hHeavyBottom);
      break;
    case DOUBLE: {
      const topLeft = l.up === DOUBLE ? vLightRight : rightLeft;
      const bottomLeft = l.down === DOUBLE ? vLightRight : rightLeft;
      box(r, topLeft, hDoubleTop, m.cellW, hLightTop);
      box(r, bottomLeft, hLightBottom, m.cellW, hDoubleBottom);
      break;
    }
  }

  switch (l.down) {
    case LIGHT:
      box(r, vLightLeft, downTop, vLightRight, m.cellH);
      break;
    case HEAVY:
      box(r, vHeavyLeft, downTop, vHeavyRight, m.cellH);
      break;
    case DOUBLE: {
      const leftTop = l.left === DOUBLE ? hLightBottom : downTop;
      const rightTop = l.right === DOUBLE ? hLightBottom : downTop;
      box(r, vDoubleLeft, leftTop, vLightLeft, m.cellH);
      box(r, vLightRight, rightTop, vDoubleRight, m.cellH);
      break;
    }
  }

  switch (l.left) {
    case LIGHT:
      box(r, 0, hLightTop, leftRight, hLightBottom);
      break;
    case HEAVY:
      box(r, 0, hHeavyTop, leftRight, hHeavyBottom);
      break;
    case DOUBLE: {
      const topRight = l.up === DOUBLE ? vLightLeft : leftRight;
      const bottomRight = l.down === DOUBLE ? vLightLeft : leftRight;
      box(r, 0, hDoubleTop, topRight, hLightTop);
      box(r, 0, hLightBottom, bottomRight, hDoubleBottom);
      break;
    }
  }
}

/**
 * Ghostty's `dashHorizontal`: {@code count} dashes with half-gaps at both edges, so tiled cells
 * read as one evenly dashed line. Leftover pixels widen dashes, never gaps.
 */
function dashHorizontal(
  r: Raster,
  m: SpriteMetrics,
  count: number,
  thickPx: number,
  desiredGap: number,
): void {
  const gapCount = count;
  if (m.cellW < count + gapCount) {
    const y0 = Math.floor(sub(m.cellH, thickPx) / 2);
    box(r, 0, y0, m.cellW, y0 + thickPx);
    return;
  }
  const gapWidth = Math.min(desiredGap, Math.floor(m.cellW / (2 * count)));
  const totalDash = m.cellW - gapCount * gapWidth;
  const dashWidth = Math.floor(totalDash / count);
  let extra = totalDash % count;
  const y = Math.floor(sub(m.cellH, thickPx) / 2);
  let x = Math.floor(gapWidth / 2);
  for (let i = 0; i < count; i++) {
    let x1 = x + dashWidth;
    if (extra > 0) {
      extra--;
      x1++;
    }
    box(r, x, y, x1, y + thickPx);
    x = x1 + gapWidth;
  }
}

/** Ghostty's `dashVertical`: dashes from the top with one full gap at the bottom. */
function dashVertical(
  r: Raster,
  m: SpriteMetrics,
  count: number,
  thickPx: number,
  desiredGap: number,
): void {
  const gapCount = count;
  if (m.cellH < count + gapCount) {
    const x0 = Math.floor(sub(m.cellW, thickPx) / 2);
    box(r, x0, 0, x0 + thickPx, m.cellH);
    return;
  }
  const gapHeight = Math.min(desiredGap, Math.floor(m.cellH / (2 * count)));
  const totalDash = m.cellH - gapCount * gapHeight;
  const dashHeight = Math.floor(totalDash / count);
  let extra = totalDash % count;
  const x = Math.floor(sub(m.cellW, thickPx) / 2);
  let y = 0;
  for (let i = 0; i < count; i++) {
    let y1 = y + dashHeight;
    if (extra > 0) {
      extra--;
      y1++;
    }
    box(r, x, y, x + thickPx, y1);
    y = y1 + gapHeight;
  }
}

/** Ghostty's `arc`: a quarter turn through the center joining two cell edges. */
function arc(r: Raster, m: SpriteMetrics, corner: Corner): void {
  const thick = strokePx(LIGHT, m.boxThickness);
  const cx = Math.floor(sub(m.cellW, thick) / 2) + thick / 2;
  const cy = Math.floor(sub(m.cellH, thick) / 2) + thick / 2;
  const radius = Math.min(m.cellW, m.cellH) / 2;
  const s = 0.25;
  r.beginPath();
  switch (corner) {
    case "tl":
      r.moveTo(cx, 0);
      r.lineTo(cx, cy - radius);
      r.bezierCurveTo(cx, cy - s * radius, cx - s * radius, cy, cx - radius, cy);
      r.lineTo(0, cy);
      break;
    case "tr":
      r.moveTo(cx, 0);
      r.lineTo(cx, cy - radius);
      r.bezierCurveTo(cx, cy - s * radius, cx + s * radius, cy, cx + radius, cy);
      r.lineTo(m.cellW, cy);
      break;
    case "bl":
      r.moveTo(cx, m.cellH);
      r.lineTo(cx, cy + radius);
      r.bezierCurveTo(cx, cy + s * radius, cx - s * radius, cy, cx - radius, cy);
      r.lineTo(0, cy);
      break;
    case "br":
      r.moveTo(cx, m.cellH);
      r.lineTo(cx, cy + radius);
      r.bezierCurveTo(cx, cy + s * radius, cx + s * radius, cy, cx + radius, cy);
      r.lineTo(m.cellW, cy);
      break;
  }
  r.lineWidth = thick;
  r.lineCap = "butt";
  r.stroke();
}

/** Ghostty's light diagonals: corner to corner, overshooting by half a pixel along the slope. */
type Diagonal = "upperRightToLowerLeft" | "upperLeftToLowerRight";

function diagonal(r: Raster, m: SpriteMetrics, direction: Diagonal): void {
  const w = m.cellW;
  const h = m.cellH;
  const slopeX = Math.min(1, w / h);
  const slopeY = Math.min(1, h / w);
  r.beginPath();
  if (direction === "upperRightToLowerLeft") {
    r.moveTo(w + 0.5 * slopeX, -0.5 * slopeY);
    r.lineTo(-0.5 * slopeX, h + 0.5 * slopeY);
  } else {
    r.moveTo(-0.5 * slopeX, -0.5 * slopeY);
    r.lineTo(w + 0.5 * slopeX, h + 0.5 * slopeY);
  }
  r.lineWidth = strokePx(LIGHT, m.boxThickness);
  r.lineCap = "butt";
  r.stroke();
}
