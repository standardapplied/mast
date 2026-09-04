import type { Raster, RasterFactory, RasterSurface } from "../src/mainview/terminal/raster";

/** One recorded draw, in absolute surface coordinates (translations already applied). */
export type RasterOp =
  | { kind: "fillRect"; x: number; y: number; w: number; h: number; fillStyle: string }
  | { kind: "fillText"; text: string; x: number; y: number; font: string; clip: Rect | null }
  | { kind: "stroke"; points: [number, number][]; lineWidth: number; clip: Rect | null };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Face metrics the stub reports for every measureText call, in device px. */
export interface StubFace {
  advance: number;
  ascent: number;
  descent: number;
  capHeight?: number;
  exHeight?: number;
}

/**
 * A recording {@link Raster}: every draw lands in {@link ops} with translations applied and the
 * active clip attached, so tests can assert exactly where paint went. {@code coloredTexts}
 * controls what getImageData reports — a text listed there reads back as colored pixels.
 */
export class RasterStub implements Raster {
  font = "";
  fillStyle: string | CanvasGradient | CanvasPattern = "#000";
  textBaseline: CanvasTextBaseline = "alphabetic";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  readonly ops: RasterOp[] = [];
  private tx = 0;
  private ty = 0;
  private clipRect: Rect | null = null;
  private readonly stack: { tx: number; ty: number; clip: Rect | null }[] = [];
  private path: [number, number][] = [];
  private pendingRect: Rect | null = null;
  private lastText: string | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly face: StubFace,
    private readonly coloredTexts: ReadonlySet<string> = new Set(),
  ) {}

  measureText(text: string): TextMetrics {
    const f = this.face;
    return {
      width: f.advance * [...text].length,
      fontBoundingBoxAscent: f.ascent,
      fontBoundingBoxDescent: f.descent,
      actualBoundingBoxAscent:
        text === "H" ? (f.capHeight ?? 0) : text === "x" ? (f.exHeight ?? 0) : 0,
      actualBoundingBoxDescent: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      alphabeticBaseline: 0,
      emHeightAscent: 0,
      emHeightDescent: 0,
      hangingBaseline: 0,
      ideographicBaseline: 0,
    } as TextMetrics;
  }

  fillText(text: string, x: number, y: number): void {
    this.lastText = text;
    this.ops.push({
      kind: "fillText",
      text,
      x: x + this.tx,
      y: y + this.ty,
      font: this.font,
      clip: this.clipRect,
    });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({
      kind: "fillRect",
      x: x + this.tx,
      y: y + this.ty,
      w,
      h,
      fillStyle: String(this.fillStyle),
    });
  }

  save(): void {
    this.stack.push({ tx: this.tx, ty: this.ty, clip: this.clipRect });
  }

  restore(): void {
    const s = this.stack.pop();
    if (!s) throw new Error("RasterStub: restore without save");
    this.tx = s.tx;
    this.ty = s.ty;
    this.clipRect = s.clip;
  }

  translate(x: number, y: number): void {
    this.tx += x;
    this.ty += y;
  }

  beginPath(): void {
    this.path = [];
    this.pendingRect = null;
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.pendingRect = { x: x + this.tx, y: y + this.ty, w, h };
  }

  clip(): void {
    if (!this.pendingRect) throw new Error("RasterStub: clip without a rect");
    this.clipRect = this.pendingRect;
  }

  moveTo(x: number, y: number): void {
    this.path.push([x + this.tx, y + this.ty]);
  }

  lineTo(x: number, y: number): void {
    this.path.push([x + this.tx, y + this.ty]);
  }

  bezierCurveTo(
    _c1x: number,
    _c1y: number,
    _c2x: number,
    _c2y: number,
    x: number,
    y: number,
  ): void {
    this.path.push([x + this.tx, y + this.ty]);
  }

  stroke(): void {
    this.ops.push({
      kind: "stroke",
      points: this.path,
      lineWidth: this.lineWidth,
      clip: this.clipRect,
    });
  }

  getImageData(_sx: number, _sy: number, sw: number, sh: number): ImageData {
    const data = new Uint8ClampedArray(sw * sh * 4);
    const colored = this.lastText !== null && this.coloredTexts.has(this.lastText);
    // Monochrome glyphs read back as white with partial alpha; colored ones carry real RGB.
    data.set(colored ? [200, 40, 60, 255] : [255, 255, 255, 128], 0);
    return { data, width: sw, height: sh, colorSpace: "srgb" } as ImageData;
  }
}

/** A factory whose every surface is a recording stub sharing one face; {@link surfaces} lists them. */
export function rasterStubFactory(
  face: StubFace,
  coloredTexts: ReadonlySet<string> = new Set(),
): RasterFactory & { surfaces: RasterStub[] } {
  const surfaces: RasterStub[] = [];
  const factory = ((width: number, height: number): RasterSurface => {
    const ctx = new RasterStub(width, height, face, coloredTexts);
    surfaces.push(ctx);
    return { width, height, ctx };
  }) as RasterFactory & { surfaces: RasterStub[] };
  factory.surfaces = surfaces;
  return factory;
}

/** Whether every pixel a draw can touch lies inside {@code r}. */
export function opInside(op: RasterOp, r: Rect): boolean {
  const inside = (x: number, y: number) =>
    x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
  switch (op.kind) {
    case "fillRect":
      return inside(op.x, op.y) && inside(op.x + op.w, op.y + op.h);
    case "fillText":
    case "stroke":
      // Text and strokes have no intrinsic bounds; they are inside only when clipped to the rect.
      return (
        op.clip !== null &&
        op.clip.x >= r.x &&
        op.clip.y >= r.y &&
        op.clip.x + op.clip.w <= r.x + r.w &&
        op.clip.y + op.clip.h <= r.y + r.h
      );
  }
}
