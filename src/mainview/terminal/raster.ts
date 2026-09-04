/**
 * The 2D raster seam. The glyph atlas and the sprite drawers paint through this interface — a
 * structural subset of {@code CanvasRenderingContext2D} — so their geometry runs under `bun test`
 * against a recording stub while the app hands them a real {@code OffscreenCanvas}.
 */
export interface Raster {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  textBaseline: CanvasTextBaseline;
  lineWidth: number;
  lineCap: CanvasLineCap;
  measureText(text: string): TextMetrics;
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  stroke(): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}

/** A pixel surface with its raster; sized once, never resized. */
export interface RasterSurface {
  readonly width: number;
  readonly height: number;
  readonly ctx: Raster;
}

export type RasterFactory = (width: number, height: number) => RasterSurface;

/** The production factory: an OffscreenCanvas per surface. */
export const offscreenRaster: RasterFactory = (width, height) => {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("terminal raster: OffscreenCanvas has no 2D context.");
  }
  return { width, height, ctx };
};
