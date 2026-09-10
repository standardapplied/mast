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
 * One atlas serves every pane drawing the same face at the same size ({@link GlyphAtlasPool}).
 * Slots are a bounded cache, not a heap: when none is free, the entry least recently referenced is
 * evicted — never one referenced in the frame being packed, so a glyph on screen is never blanked;
 * a single frame that needs more slots than exist grows the atlas instead. Each slot remembers
 * when it was last written, so a backend uploads only the slots written since its own last upload
 * ({@link patchesSince}), never the whole bitmap.
 *
 * Glyphs are drawn white on transparent; a glyph that reads back with real color (an emoji) is
 * flagged so the renderer draws it as-is instead of tinting it.
 */

import { type CellMetrics, cellMetrics, knownFace } from "./fontMetrics";
import { offscreenRaster, type Raster, type RasterFactory, type RasterSurface } from "./raster";
import { drawSprite, spriteCodepoint } from "./sprites";
import { drawSpecial, type SpecialKind } from "./sprites/special";

/** The style attributes that change how a glyph is rasterized (color is applied later, at draw).
 *  Decorations (underline, strikethrough, overline) are separate {@link GlyphAtlas.special} entries
 *  layered by the renderer, so they never vary the glyph slot. */
export interface GlyphStyle {
  readonly bold: boolean;
  readonly italic: boolean;
}

export const PLAIN_GLYPH: GlyphStyle = { bold: false, italic: false };

/** A rectangle of the bitmap, in device pixels, with its pixels read back for upload. */
export interface AtlasPatch {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

const BLANK = 0;
/** The tallest texture every WebGPU/WebGL2 implementation guarantees; growth stops there. */
const MAX_TEXTURE_PX = 8192;

type Draw = (ctx: Raster, width: number) => boolean;

export class GlyphAtlas {
  readonly metrics: CellMetrics;
  private surface: RasterSurface;
  private ctx: Raster;
  private readonly index = new Map<string, number>();
  private readonly family: string;
  private readonly px: number;
  private readonly cols: number;
  private rows: number;
  private readonly maxRows: number;
  /** Per head slot: the entry's key, span, draw and color flag; per slot: owner, use and write stamps. */
  private keys: (string | null)[] = [];
  private draws: (Draw | null)[] = [];
  private spans!: Uint8Array;
  private color!: Uint8Array;
  private owner!: Int32Array;
  private lastUsed!: Float64Array;
  private writtenAt!: Float64Array;
  /** The frame being packed; a slot stamped with it is referenced right now. */
  private tick = 1;
  private writeCount = 0;

  constructor(
    private readonly raster: RasterFactory,
    fontFamily: string,
    fontPx: number,
    dpr: number,
    cols = 64,
    rows = 64,
    maxRows?: number,
  ) {
    this.family = fontFamily;
    this.px = Math.round(fontPx * dpr);
    this.metrics = cellMetrics(measureFace(raster(64, 64).ctx, fontFamily, this.px));
    this.cols = cols;
    this.rows = rows;
    this.maxRows = Math.max(rows, maxRows ?? Math.floor(MAX_TEXTURE_PX / this.metrics.cellH));
    this.surface = this.newSurface();
    this.ctx = this.surface.ctx;
    this.allocateSlots(cols * rows);
  }

  /** Begins a frame: entries referenced from here on are safe from eviction until the next one. */
  nextFrame(): void {
    this.tick++;
  }

  /**
   * The atlas index for {@code text} rendered in {@code style}; blank is 0. Rasterizes on first
   * sight, keyed by (text, style, wide): bold/italic pick the font face. Color is applied per cell
   * at draw time, so one entry serves every color the same styled grapheme ever appears in.
   */
  glyph(text: string, style: GlyphStyle = PLAIN_GLYPH, wide = false): number {
    if (text === "" || text === " ") return BLANK;
    return this.entry(glyphKey(text, style, wide), wide, (ctx) => {
      const sprite = spriteCodepoint(text);
      if (sprite !== null) {
        drawSprite(sprite, ctx, this.metrics);
        return false;
      }
      const face = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}`;
      ctx.font = `${face}${this.px}px ${this.family}`;
      ctx.fillText(text, 0, this.metrics.baseline);
      return true;
    });
  }

  /** The atlas index of a decoration or cursor sprite spanning one cell (two when {@code wide}). */
  special(kind: SpecialKind, wide = false): number {
    return this.entry(`${kind}${wide ? "w" : ""}`, wide, (ctx, w) => {
      drawSpecial(kind, ctx, this.metrics, w);
      return false;
    });
  }

  /** Whether the entry carries its own colors (an emoji) rather than a tintable white mask. */
  isColor(id: number): boolean {
    return this.color[id] === 1;
  }

  cell(id: number): { u: number; v: number } {
    return { u: id % this.cols, v: Math.floor(id / this.cols) };
  }

  get atlasCols(): number {
    return this.cols;
  }
  get atlasRows(): number {
    return this.rows;
  }
  get width(): number {
    return this.surface.width;
  }
  get height(): number {
    return this.surface.height;
  }
  /** How many slot draws have happened; a backend remembers the count it last uploaded through. */
  get writes(): number {
    return this.writeCount;
  }
  /** The entries currently held (blank excluded). */
  get size(): number {
    return this.index.size;
  }
  /** Whether the styled grapheme currently occupies a slot. */
  has(text: string, style: GlyphStyle = PLAIN_GLYPH, wide = false): boolean {
    return this.index.has(glyphKey(text, style, wide));
  }

  /**
   * The bitmap regions written after the first {@code mark} draws, as row-wise runs of slots with
   * their pixels read synchronously. Uploading these exact bytes — rather than handing the canvas
   * to {@code copyExternalImageToTexture} / {@code texImage2D} — sidesteps a WebKit WebGPU quirk
   * where the canvas snapshot can miss a {@code fillText} done earlier in the same tick.
   */
  patchesSince(mark: number): AtlasPatch[] {
    const patches: AtlasPatch[] = [];
    const { cellW, cellH } = this.metrics;
    for (let v = 0; v < this.rows; v++) {
      let run = -1;
      for (let u = 0; u <= this.cols; u++) {
        const dirty = u < this.cols && this.writtenAt[v * this.cols + u]! > mark;
        if (dirty && run < 0) run = u;
        if (!dirty && run >= 0) {
          const x = run * cellW;
          const y = v * cellH;
          const width = (u - run) * cellW;
          patches.push({ x, y, width, height: cellH, pixels: this.ctx.getImageData(x, y, width, cellH).data });
          run = -1;
        }
      }
    }
    return patches;
  }

  /**
   * The slot for {@code key}: the one it holds, else a free slot, else the least recently referenced
   * one (never one referenced this frame), else a slot of a grown atlas. The entry is drawn clipped
   * and translated so cell-local coordinates apply; {@code draw} returns whether the entry came
   * from a font and must be checked for color.
   */
  private entry(key: string, wide: boolean, draw: Draw): number {
    const hit = this.index.get(key);
    if (hit !== undefined) {
      this.touch(hit);
      return hit;
    }
    const span = wide ? 2 : 1;
    let id = this.claim(span);
    if (id === BLANK) {
      this.grow();
      id = this.claim(span);
      if (id === BLANK) {
        throw new Error("GlyphAtlas: a single frame references more glyphs than the atlas can hold");
      }
    }
    this.index.set(key, id);
    this.keys[id] = key;
    this.draws[id] = draw;
    this.spans[id] = span;
    for (let s = id; s < id + span; s++) this.owner[s] = id;
    this.touch(id);
    this.paint(id);
    return id;
  }

  private touch(id: number): void {
    for (let s = id; s < id + this.spans[id]!; s++) this.lastUsed[s] = this.tick;
  }

  /** Frees and returns the best slot for {@code span} cells, or blank when every slot is in use this frame. */
  private claim(span: number): number {
    const n = this.cols * this.rows;
    const lastUsed = this.lastUsed;
    let best = BLANK;
    let bestAge = this.tick;
    for (let i = 1; i + span <= n; i++) {
      if (span === 2 && i % this.cols === this.cols - 1) continue;
      const age = span === 2 ? Math.max(lastUsed[i]!, lastUsed[i + 1]!) : lastUsed[i]!;
      if (age >= bestAge) continue;
      best = i;
      bestAge = age;
      if (age === 0) break;
    }
    if (best === BLANK) return BLANK;
    for (let s = best; s < best + span; s++) {
      const head = this.owner[s]!;
      if (head !== BLANK) this.evict(head);
    }
    return best;
  }

  private evict(head: number): void {
    this.index.delete(this.keys[head]!);
    this.keys[head] = null;
    this.draws[head] = null;
    this.color[head] = 0;
    for (let s = head; s < head + this.spans[head]!; s++) {
      this.owner[s] = BLANK;
      this.lastUsed[s] = 0;
    }
    this.spans[head] = 0;
  }

  /** Clears the entry's slot and draws it there; the slot is stamped as written. */
  private paint(id: number): void {
    const { cellW, cellH } = this.metrics;
    const span = this.spans[id]!;
    const x0 = (id % this.cols) * cellW;
    const y0 = Math.floor(id / this.cols) * cellH;
    const w = span * cellW;
    const ctx = this.ctx;
    ctx.clearRect(x0, y0, w, cellH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, cellH);
    ctx.clip();
    ctx.translate(x0, y0);
    const fromFont = this.draws[id]!(ctx, w);
    ctx.restore();
    this.color[id] = fromFont && hasColor(ctx.getImageData(x0, y0, w, cellH).data) ? 1 : 0;
    this.writeCount++;
    for (let s = id; s < id + span; s++) this.writtenAt[s] = this.writeCount;
  }

  /** Doubles the rows (to the texture limit) and repaints every entry in place on a fresh bitmap. */
  private grow(): void {
    const rows = Math.min(this.rows * 2, this.maxRows);
    if (rows === this.rows) return;
    const before = this.cols * this.rows;
    const spans = this.spans;
    const color = this.color;
    const owner = this.owner;
    const lastUsed = this.lastUsed;
    this.rows = rows;
    this.surface = this.newSurface();
    this.ctx = this.surface.ctx;
    this.allocateSlots(this.cols * rows);
    this.spans.set(spans);
    this.color.set(color);
    this.owner.set(owner);
    this.lastUsed.set(lastUsed);
    for (let id = 1; id < before; id++) {
      if (this.spans[id] !== 0) this.paint(id);
    }
  }

  private newSurface(): RasterSurface {
    const surface = this.raster(this.cols * this.metrics.cellW, this.rows * this.metrics.cellH);
    surface.ctx.textBaseline = "alphabetic";
    surface.ctx.fillStyle = "#fff";
    return surface;
  }

  private allocateSlots(n: number): void {
    this.keys.length = n;
    this.draws.length = n;
    this.spans = new Uint8Array(n);
    this.color = new Uint8Array(n);
    this.owner = new Int32Array(n);
    this.lastUsed = new Float64Array(n);
    this.writtenAt = new Float64Array(n);
    this.lastUsed[BLANK] = Number.POSITIVE_INFINITY;
  }
}

/**
 * One atlas per (face, size, dpr), shared by every renderer that acquires it and dropped once the
 * last one releases it: ten panes at the same font rasterize each glyph once and hold one bitmap.
 */
export class GlyphAtlasPool {
  private readonly held = new Map<string, { atlas: GlyphAtlas; refs: number }>();

  constructor(private readonly raster: RasterFactory) {}

  acquire(fontFamily: string, fontPx: number, dpr: number): GlyphAtlas {
    const key = `${fontFamily}|${fontPx}|${dpr}`;
    let entry = this.held.get(key);
    if (!entry) {
      entry = { atlas: new GlyphAtlas(this.raster, fontFamily, fontPx, dpr), refs: 0 };
      this.held.set(key, entry);
    }
    entry.refs++;
    return entry.atlas;
  }

  release(atlas: GlyphAtlas): void {
    for (const [key, entry] of this.held) {
      if (entry.atlas !== atlas) continue;
      if (--entry.refs === 0) this.held.delete(key);
      return;
    }
    throw new Error("GlyphAtlasPool: releasing an atlas it does not hold");
  }

  /** How many atlases are alive. */
  get size(): number {
    return this.held.size;
  }
}

/** The app's pool: an OffscreenCanvas per atlas. */
export const glyphAtlasPool = new GlyphAtlasPool(offscreenRaster);

function glyphKey(text: string, style: GlyphStyle, wide: boolean): string {
  return `${style.bold ? "b" : ""}${style.italic ? "i" : ""}${wide ? "w" : ""}|${text}`;
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
