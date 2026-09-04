/**
 * Cell metrics from face metrics — a port of Ghostty's `font.Metrics.calc`, so a Mast cell is laid
 * out exactly the way a native Ghostty cell is: the cell is the rounded advance × rounded line
 * height, the baseline is centered in the rounded cell, and underline/strikethrough positions come
 * from the face (or Ghostty's estimates when the face does not define them).
 *
 * All inputs are device pixels. Face values follow the font convention: relative to the baseline,
 * +Y up, so a descent is negative. Outputs are integer device pixels measured from the top of the
 * cell, which is what a raster draws with.
 */

/** What a font face reports about itself, in device pixels at the rendering size. */
export interface FaceMetrics {
  /** Advance width of a cell glyph. */
  readonly advance: number;
  readonly ascent: number;
  /** Typically negative (below the baseline). */
  readonly descent: number;
  readonly lineGap: number;
  /** Top of the underline stroke relative to the baseline (+Y up); usually negative. */
  readonly underlinePosition?: number;
  readonly underlineThickness?: number;
  /** Top of the strikethrough stroke relative to the baseline (+Y up). */
  readonly strikethroughPosition?: number;
  readonly strikethroughThickness?: number;
  readonly capHeight?: number;
  readonly exHeight?: number;
}

/** Integer device-pixel geometry of one cell, measured from its top-left corner. */
export interface CellMetrics {
  readonly cellW: number;
  readonly cellH: number;
  /** Distance from the top of the cell to the alphabetic baseline. */
  readonly baseline: number;
  /** Top of the underline stroke, from the top of the cell. */
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  /** Top of the strikethrough stroke, from the top of the cell. */
  readonly strikethroughPosition: number;
  readonly strikethroughThickness: number;
  /** Stroke width of the light box-drawing line (heavy is twice this). */
  readonly boxThickness: number;
}

/**
 * Table metrics (post, OS/2) of faces we ship, in em units. A 2D canvas cannot read font tables,
 * so without this the underline and box strokes would fall back to Ghostty's estimates and come
 * out heavier than native Ghostty draws the same font.
 */
const KNOWN_FACES: Record<string, Omit<FaceMetrics, "advance" | "ascent" | "descent" | "lineGap">> =
  {
    "JetBrains Mono": {
      underlinePosition: -0.155,
      underlineThickness: 0.05,
      strikethroughPosition: 0.32,
      strikethroughThickness: 0.05,
      capHeight: 0.73,
      exHeight: 0.55,
    },
  };

/**
 * The table metrics of the first known family in a CSS font-family list, scaled to {@code px};
 * empty when no family is known.
 */
export function knownFace(fontFamily: string, px: number): Partial<FaceMetrics> {
  for (const raw of fontFamily.split(",")) {
    const family = raw.trim().replace(/^["']|["']$/g, "");
    const em = KNOWN_FACES[family];
    if (em) {
      return Object.fromEntries(Object.entries(em).map(([k, v]) => [k, v * px]));
    }
  }
  return {};
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`cellMetrics: ${name} must be a finite non-negative number (got ${value})`);
  }
  return value;
}

function defined(value: number | undefined): value is number {
  return value !== undefined && value > 0;
}

/** Ghostty's `Metrics.calc`, with its estimation heuristics for metrics the face lacks. */
export function cellMetrics(face: FaceMetrics): CellMetrics {
  const faceWidth = positive("advance", face.advance);
  const ascent = positive("ascent", face.ascent);
  const faceHeight = ascent - face.descent + face.lineGap;

  const cellW = Math.max(1, Math.round(faceWidth));
  const cellH = Math.max(1, Math.round(faceHeight));

  const faceBaseline = face.lineGap / 2 - face.descent;
  const baselineFromBottom = Math.round(faceBaseline - (cellH - faceHeight) / 2);
  const topToBaseline = cellH - baselineFromBottom;

  const capHeight = defined(face.capHeight) ? face.capHeight : 0.75 * ascent;
  const exHeight = defined(face.exHeight) ? face.exHeight : 0.75 * capHeight;
  const underlineThicknessRaw = defined(face.underlineThickness)
    ? face.underlineThickness
    : 0.15 * exHeight;
  const strikethroughThicknessRaw = defined(face.strikethroughThickness)
    ? face.strikethroughThickness
    : underlineThicknessRaw;
  const underlineThickness = Math.max(1, Math.ceil(underlineThicknessRaw));
  const strikethroughThickness = Math.max(1, Math.ceil(strikethroughThicknessRaw));
  const underlinePosition = face.underlinePosition ?? -underlineThicknessRaw;
  const strikethroughPosition =
    face.strikethroughPosition ?? (exHeight + strikethroughThicknessRaw) * 0.5;

  return {
    cellW,
    cellH,
    baseline: topToBaseline,
    underlinePosition: Math.round(topToBaseline - underlinePosition),
    underlineThickness,
    strikethroughPosition: Math.round(topToBaseline - strikethroughPosition),
    strikethroughThickness,
    boxThickness: underlineThickness,
  };
}
