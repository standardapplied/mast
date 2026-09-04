/**
 * Decoration and cursor sprites — a port of Ghostty's `font/sprite/draw/special.zig`. These are
 * not codepoints: the renderer layers them over a cell from its style (underline variants,
 * strikethrough, overline) or its cursor shape. Drawing them from the cell metrics keeps every
 * decoration on the same pixel row across the line, whatever glyph sits above it.
 */

import type { CellMetrics } from "../fontMetrics";
import type { Raster } from "../raster";
import { box, sub } from "./sprite";

export type SpecialKind =
  | "underline"
  | "underline_double"
  | "underline_dotted"
  | "underline_dashed"
  | "underline_curly"
  | "strikethrough"
  | "overline"
  | "cursor_hollow"
  | "cursor_bar"
  | "cursor_underline";

export const SPECIAL_KINDS: readonly SpecialKind[] = [
  "underline",
  "underline_double",
  "underline_dotted",
  "underline_dashed",
  "underline_curly",
  "strikethrough",
  "overline",
  "cursor_hollow",
  "cursor_bar",
  "cursor_underline",
];

/** Draws {@code kind} across a {@code width}-pixel-wide cell (two cells for a wide glyph). */
export function drawSpecial(kind: SpecialKind, r: Raster, m: CellMetrics, width: number): void {
  const h = m.cellH;
  const t = m.underlineThickness;
  const underlineY = Math.min(m.underlinePosition, sub(h, t));
  switch (kind) {
    case "underline":
      box(r, 0, underlineY, width, underlineY + t);
      return;
    case "underline_double": {
      const y = Math.min(m.underlinePosition, sub(h, 2 * t));
      box(r, 0, sub(y, t), width, y);
      box(r, 0, y + t, width, y + 2 * t);
      return;
    }
    case "underline_dotted": {
      // Ghostty draws round dots of radius t/√2; squares of the same footprint read identically
      // at stroke sizes and need no path support from the raster.
      const radius = Math.SQRT1_2 * t;
      const y = Math.min(m.underlinePosition + 0.5 * t, h - Math.ceil(radius));
      const count = Math.max(
        1,
        Math.min(
          Math.ceil(width / (4 * radius)),
          Math.floor(width / (3 * radius)),
          Math.floor(width / (2 * radius + 1)),
        ),
      );
      const step = width / count;
      for (let i = 0; i < count; i++) {
        const cx = step / 2 + i * step;
        r.fillRect(cx - radius, y - radius, 2 * radius, 2 * radius);
      }
      return;
    }
    case "underline_dashed": {
      const dashWidth = Math.floor(width / 3) + 1;
      const dashCount = Math.floor(width / dashWidth) + 1;
      for (let i = 0; i < dashCount; i += 2) {
        box(r, i * dashWidth, underlineY, Math.min(width, (i + 1) * dashWidth), underlineY + t);
      }
      return;
    }
    case "underline_curly": {
      const amplitude = width / Math.PI;
      const top = Math.min(m.underlinePosition, h - amplitude - t);
      const bottom = top + amplitude;
      const center = 0.5 * width;
      const s = 0.4;
      r.beginPath();
      r.moveTo(0, bottom);
      r.bezierCurveTo(center * s, bottom, center - center * s, top, center, top);
      r.bezierCurveTo(center + center * s, top, width - center * s, bottom, width, bottom);
      r.lineWidth = t;
      r.lineCap = "round";
      r.stroke();
      return;
    }
    case "strikethrough":
      box(r, 0, m.strikethroughPosition, width, m.strikethroughPosition + m.strikethroughThickness);
      return;
    case "overline":
      box(r, 0, 0, width, t);
      return;
    case "cursor_hollow": {
      const c = m.cursorThickness;
      box(r, 0, 0, width, c);
      box(r, 0, sub(h, c), width, h);
      box(r, 0, c, c, sub(h, c));
      box(r, sub(width, c), c, width, sub(h, c));
      return;
    }
    case "cursor_bar":
      box(r, 0, 0, m.cursorThickness, h);
      return;
    case "cursor_underline":
      box(r, 0, underlineY, width, underlineY + m.cursorThickness);
      return;
  }
}
