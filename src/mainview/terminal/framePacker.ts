/**
 * packFrame — turns the terminal grid into the two instance buffers the GPU draws, with no GPU in
 * sight. One background instance per cell, then foreground instances in draw order: decorations
 * (underline, strikethrough, overline) first so text layers over them, glyphs, and finally a
 * bar/underline/hollow cursor. A block cursor is a background swap, as in a native terminal. The
 * selection is the terminal's own: a cell arrives flagged, and paints in the selection colors. The
 * hovered link's cells gain a single underline where they had none. The other search matches on
 * screen get a background tint only — the selected match is the selection — so text stays as is.
 *
 * Pure, so the layering rules are provable under `bun test` with a stub atlas; the renderer only
 * uploads what this packs.
 */

import type { GlyphStyle } from "./glyphAtlas";
import type { SpecialKind } from "./sprites/special";
import type { TerminalGrid } from "./terminalGrid";
import type { Cell, Cursor, CursorStyle, LinkRun, MatchSpan, Rgb, UnderlineStyle } from "./vtCore";

/** Floats per foreground instance: x, y, r, g, b, u, v, w, mode. */
export const FG_STRIDE = 9;
/** Floats per background instance: r, g, b. */
export const BG_STRIDE = 3;
/** The most foreground instances a frame can need: glyph + three decorations per cell + cursor. */
export const FG_PER_CELL = 4;

/** Instance mode: tint the white mask with the cell color, or draw the entry's own colors. */
const MODE_TINT = 0;
const MODE_COLOR = 1;
/** How far a search match's background moves toward the selection color: visible, not selected. */
export const MATCH_TINT = 0.35;
/** What paints over a cell's own background: the selection, another search match, or nothing. */
type Highlight = "selection" | "match" | null;

/** What the packer needs from the atlas; {@link GlyphAtlas} implements it structurally. */
export interface AtlasLike {
  glyph(text: string, style: GlyphStyle, wide: boolean): number;
  special(kind: SpecialKind, wide: boolean): number;
  isColor(id: number): boolean;
  /** Slots per atlas row: an id's cell is (id % cols, id / cols). */
  readonly atlasCols: number;
}

export interface FrameColors {
  readonly bg: Rgb;
  readonly cursor: Rgb;
  readonly selectionBg: Rgb;
  readonly selectionFg: Rgb;
}

export interface FrameBuffers {
  /** cols × rows × {@link BG_STRIDE} */
  readonly bg: Float32Array;
  /** (cols × rows × {@link FG_PER_CELL} + 1) × {@link FG_STRIDE} */
  readonly fg: Float32Array;
}

const UNDERLINE_SPRITE: Record<Exclude<UnderlineStyle, "none">, SpecialKind> = {
  single: "underline",
  double: "underline_double",
  curly: "underline_curly",
  dotted: "underline_dotted",
  dashed: "underline_dashed",
};

const CURSOR_SPRITE: Partial<Record<CursorStyle, SpecialKind>> = {
  bar: "cursor_bar",
  underline: "cursor_underline",
  hollow: "cursor_hollow",
};

/** Packs {@code grid} into {@code out} and returns the foreground instance count. */
export function packFrame(
  grid: TerminalGrid,
  cursor: Cursor,
  atlas: AtlasLike,
  colors: FrameColors,
  out: FrameBuffers,
  hover: LinkRun | null = null,
  matches: readonly MatchSpan[] = [],
): number {
  const cursorShown = cursor.present && cursor.visible;
  const matched = matchFlags(matches, grid.cols, grid.rows);
  const blockCursor = cursorShown && cursor.style === "block";
  const cursorColor = cursor.color ?? colors.cursor;
  let fgCount = 0;
  const atlasCols = atlas.atlasCols;
  const put = (x: number, y: number, id: number, color: Rgb, wide: boolean, mode: number) => {
    const o = fgCount * FG_STRIDE;
    const fg = out.fg;
    fg[o] = x;
    fg[o + 1] = y;
    fg[o + 2] = color[0] / 255;
    fg[o + 3] = color[1] / 255;
    fg[o + 4] = color[2] / 255;
    fg[o + 5] = id % atlasCols;
    fg[o + 6] = Math.floor(id / atlasCols);
    fg[o + 7] = wide ? 2 : 1;
    fg[o + 8] = mode;
    fgCount++;
  };

  for (let y = 0; y < grid.rows; y++) {
    let afterWide = false;
    let highlight: Highlight = null;
    for (let x = 0; x < grid.cols; x++) {
      const cell = grid.cell(x, y);
      const onBlockCursor = blockCursor && cursor.x === x && cursor.y === y;
      // A wide glyph's spacer is its right half: a selection or match that ends on the glyph
      // stops at the head cell, so the spacer takes the head's highlight.
      if (!afterWide) {
        highlight = cell.selected ? "selection" : matched?.[y * grid.cols + x] ? "match" : null;
      }
      const selected = !onBlockCursor && highlight === "selection";
      const cellBg = onBlockCursor
        ? cursorColor
        : selected
          ? colors.selectionBg
          : highlight === "match"
            ? matchBg(cell.bg, colors.selectionBg)
            : cell.bg;
      const bi = (y * grid.cols + x) * BG_STRIDE;
      out.bg[bi] = cellBg[0] / 255;
      out.bg[bi + 1] = cellBg[1] / 255;
      out.bg[bi + 2] = cellBg[2] / 255;

      // The spacer after a wide glyph carries the glyph's style; the glyph's own instances
      // already span it, so drawing them again would double every decoration.
      if (afterWide) {
        afterWide = false;
        continue;
      }
      const wide = cell.width === 2;
      afterWide = wide;

      const text = onBlockCursor ? colors.bg : selected ? colors.selectionFg : textColor(cell);
      const hovered = hover !== null && hover.spans.some((s) => s.y === y && x >= s.start && x < s.end);
      const underline = cell.underline === "none" && hovered ? "single" : cell.underline;
      if (underline !== "none") {
        const color = onBlockCursor || selected ? text : (cell.underlineColor ?? text);
        put(x, y, atlas.special(UNDERLINE_SPRITE[underline], wide), color, wide, MODE_TINT);
      }
      if (cell.strikethrough) {
        put(x, y, atlas.special("strikethrough", wide), text, wide, MODE_TINT);
      }
      if (cell.overline) {
        put(x, y, atlas.special("overline", wide), text, wide, MODE_TINT);
      }

      if (cell.invisible) continue;
      const glyph = atlas.glyph(cell.text, cell, wide);
      if (glyph !== 0) {
        put(x, y, glyph, text, wide, atlas.isColor(glyph) ? MODE_COLOR : MODE_TINT);
      }
    }
  }

  const sprite = cursorShown ? CURSOR_SPRITE[cursor.style] : undefined;
  if (sprite) {
    const wide = grid.cell(cursor.x, cursor.y).width === 2;
    put(cursor.x, cursor.y, atlas.special(sprite, wide), cursorColor, wide, MODE_TINT);
  }
  return fgCount;
}

/** One flag per cell inside a match span; null when there is nothing to tint. */
function matchFlags(matches: readonly MatchSpan[], cols: number, rows: number): Uint8Array | null {
  if (matches.length === 0) return null;
  const flags = new Uint8Array(cols * rows);
  for (const span of matches) {
    if (span.y < 0 || span.y >= rows) continue;
    const from = Math.max(0, span.start);
    const to = Math.min(cols, span.end);
    for (let x = from; x < to; x++) flags[span.y * cols + x] = 1;
  }
  return flags;
}

/** A match's background: the cell's own moved {@link MATCH_TINT} of the way toward the selection's. */
export function matchBg(bg: Rgb, selectionBg: Rgb): Rgb {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * MATCH_TINT);
  return [mix(bg[0], selectionBg[0]), mix(bg[1], selectionBg[1]), mix(bg[2], selectionBg[2])];
}

/** The glyph color: faint dims the text halfway toward its own background. */
function textColor(cell: Cell): Rgb {
  if (!cell.faint) return cell.fg;
  return [
    (cell.fg[0] + cell.bg[0]) / 2,
    (cell.fg[1] + cell.bg[1]) / 2,
    (cell.fg[2] + cell.bg[2]) / 2,
  ];
}
