/**
 * GlyphAtlas — rasterizes each styled grapheme once into a fixed-slot bitmap and hands out a stable
 * index per entry; the renderer samples the slot as a texture and tints it per cell.
 *
 * Every draw is clipped to its own slot. That is the whole defence against the field bug this file
 * replaced: a font glyph designed for its own line height (JetBrains Mono's `│` runs 5.6 px above
 * and 2 px below our cell) painted into the slots above and below it — other letters — and every
 * TUI that drew a box left permanent tinted dots under unrelated text. Box drawing, block elements
 * and braille are drawn by the sprite face from cell geometry, as Ghostty does, so they also join
 * their neighbours exactly at the cell edge.
 *
 * Glyphs are drawn white on transparent; a glyph that reads back with real color (an emoji) is
 * flagged so the renderer draws it as-is instead of tinting it.
 */

import { type CellMetrics, cellMetrics, knownFace } from "./fontMetrics";
import type { Raster, RasterFactory, RasterSurface } from "./raster";
import { drawSprite, spriteCodepoint } from "./sprites";

/** The style attributes that change how a glyph is rasterized (color is applied later, at draw). */
export interface GlyphStyle {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
}

export const PLAIN_GLYPH: GlyphStyle = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
};

const BLANK = 0;

export class GlyphAtlas {
  readonly metrics: CellMetrics;
  private readonly surface: RasterSurface;
  private readonly ctx: Raster;
  private readonly index = new Map<string, number>();
  private readonly color: boolean[] = [false];
  private readonly family: string;
  private readonly px: number;
  private next = 1;
  private generation = 0;

  constructor(
    raster: RasterFactory,
    fontFamily: string,
    fontPx: number,
    dpr: number,
    private readonly cols = 64,
    private readonly rows = 64,
  ) {
    this.family = fontFamily;
    this.px = Math.round(fontPx * dpr);
    this.metrics = cellMetrics(measureFace(raster(64, 64).ctx, fontFamily, this.px));
    this.surface = raster(this.cols * this.metrics.cellW, this.rows * this.metrics.cellH);
    this.ctx = this.surface.ctx;
    this.ctx.textBaseline = "alphabetic";
    this.ctx.fillStyle = "#fff";
  }

  /**
   * The atlas index for {@code text} rendered in {@code style}; blank with no decoration is 0.
   * Rasterizes on first sight, keyed by (text, style, wide): bold/italic pick the font face,
   * underline and strikethrough draw rules into the slot. Color is applied per cell at draw time,
   * so one entry serves every color the same styled grapheme ever appears in. A full atlas
   * returns blank rather than corrupting an occupied slot.
   */
  glyph(text: string, style: GlyphStyle = PLAIN_GLYPH, wide = false): number {
    const blank = text === "" || text === " ";
    if (blank && !style.underline && !style.strikethrough) return BLANK;
    const key = `${style.bold ? "b" : ""}${style.italic ? "i" : ""}${style.underline ? "u" : ""}${
      style.strikethrough ? "s" : ""
    }${wide ? "w" : ""}|${text}`;
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;
    const span = wide ? 2 : 1;
    if (wide && this.next % this.cols === this.cols - 1) this.next++;
    if (this.next + span > this.cols * this.rows) return BLANK;
    const id = this.next;
    this.next += span;
    this.index.set(key, id);
    this.color[id] = this.rasterize(id, span, blank ? null : text, style);
    this.generation++;
    return id;
  }

  /** Whether the entry carries its own colors (an emoji) rather than a tintable white mask. */
  isColor(id: number): boolean {
    return this.color[id] ?? false;
  }

  cell(id: number): { u: number; v: number } {
    return { u: id % this.cols, v: Math.floor(id / this.cols) };
  }

  get atlasCols(): number {
    return this.cols;
  }
  get width(): number {
    return this.surface.width;
  }
  get height(): number {
    return this.surface.height;
  }
  /** Bumps when new glyphs were rasterized, so a backend knows to re-upload the texture. */
  get version(): number {
    return this.generation;
  }

  /**
   * The bitmap's pixels, read synchronously. Uploading these exact bytes — rather than handing the
   * canvas to {@code copyExternalImageToTexture} / {@code texImage2D} — sidesteps a WebKit WebGPU
   * quirk where the canvas snapshot can miss a {@code fillText} done earlier in the same tick.
   */
  pixels(): Uint8ClampedArray {
    return this.ctx.getImageData(0, 0, this.width, this.height).data;
  }

  private rasterize(id: number, span: number, text: string | null, style: GlyphStyle): boolean {
    const { cellW, cellH } = this.metrics;
    const { u, v } = this.cell(id);
    const x0 = u * cellW;
    const y0 = v * cellH;
    const w = span * cellW;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, cellH);
    ctx.clip();
    ctx.translate(x0, y0);
    let colored = false;
    if (text !== null) {
      const sprite = spriteCodepoint(text);
      if (sprite !== null) {
        drawSprite(sprite, ctx, this.metrics);
      } else {
        const face = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}`;
        ctx.font = `${face}${this.px}px ${this.family}`;
        ctx.fillText(text, 0, this.metrics.baseline);
        colored = hasColor(ctx.getImageData(x0, y0, w, cellH).data);
      }
    }
    if (style.underline) {
      ctx.fillRect(0, this.metrics.underlinePosition, w, this.metrics.underlineThickness);
    }
    if (style.strikethrough) {
      ctx.fillRect(0, this.metrics.strikethroughPosition, w, this.metrics.strikethroughThickness);
    }
    ctx.restore();
    return colored;
  }
}

/** Whether any visible pixel is not white — a monochrome mask drawn in white never is. */
function hasColor(rgba: Uint8ClampedArray): boolean {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! > 0 && (rgba[i]! < 250 || rgba[i + 1]! < 250 || rgba[i + 2]! < 250)) {
      return true;
    }
  }
  return false;
}

/** Measures the face the way a 2D context can, then overlays the table metrics of a known face. */
function measureFace(probe: Raster, fontFamily: string, px: number) {
  probe.font = `${px}px ${fontFamily}`;
  const m = probe.measureText("M");
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
    throw new Error(
      `GlyphAtlas: no font bounding box for ${fontFamily} (ascent=${ascent}, descent=${descent})`,
    );
  }
  return {
    advance: m.width,
    ascent,
    descent: -descent,
    lineGap: 0,
    capHeight: probe.measureText("H").actualBoundingBoxAscent,
    exHeight: probe.measureText("x").actualBoundingBoxAscent,
    ...knownFace(fontFamily, px),
  };
}
