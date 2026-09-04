import { describe, expect, test } from "bun:test";
import { cellMetrics, type FaceMetrics, knownFace } from "./fontMetrics";

/** JetBrains Mono at 30 device px (15 CSS px × 2), from its hhea/OS/2/post tables. */
const JETBRAINS_30: FaceMetrics = {
  advance: 18,
  ascent: 30.6,
  descent: -9,
  lineGap: 0,
  underlinePosition: -4.65,
  underlineThickness: 1.5,
  strikethroughPosition: 9.6,
  strikethroughThickness: 1.5,
  capHeight: 21.9,
  exHeight: 16.5,
};

describe("cellMetrics (a port of Ghostty's Metrics.calc)", () => {
  test("cell size is the rounded advance and line height; the baseline is centered", () => {
    const m = cellMetrics(JETBRAINS_30);
    expect(m.cellW).toBe(18);
    expect(m.cellH).toBe(40); // round(30.6 + 9 + 0)
    // Ghostty: cell_baseline (from the bottom) = round((gap/2 - descent) - (cellH - faceH)/2) = 9
    expect(m.baseline).toBe(31); // from the top, where fillText wants it
  });

  test("underline and strikethrough come from the face when it defines them", () => {
    const m = cellMetrics(JETBRAINS_30);
    // top of the stroke: top_to_baseline - underline_position = 31 - (-4.65) = 35.65 → 36
    expect(m.underlinePosition).toBe(36);
    expect(m.underlineThickness).toBe(2); // ceil(1.5)
    expect(m.strikethroughPosition).toBe(21); // round(31 - 9.6)
    expect(m.strikethroughThickness).toBe(2);
    expect(m.boxThickness).toBe(2); // box lines share the underline thickness
    expect(m.cursorThickness).toBe(2); // so do the bar, underline and hollow cursors
  });

  test("estimates the way Ghostty does when the face lacks a metric", () => {
    const m = cellMetrics({ advance: 10.4, ascent: 20, descent: -5, lineGap: 2 });
    expect(m.cellW).toBe(10);
    expect(m.cellH).toBe(27);
    // capHeight = 0.75·ascent = 15; exHeight = 0.75·cap = 11.25; thickness = ceil(0.15·ex) = 2
    expect(m.underlineThickness).toBe(2);
    // baseline from bottom = round((1 - (-5)) - (27 - 27)/2) = 6 → from top 21;
    // underline top = round(21 - (-2)) = 23 (one thickness below the baseline)
    expect(m.baseline).toBe(21);
    expect(m.underlinePosition).toBe(23);
    // strikethrough centered on the ex height with the raw (unrounded) thickness 1.6875:
    // round(21 - (11.25 + 1.6875)/2) = 15
    expect(m.strikethroughPosition).toBe(15);
  });

  test("half the line gap goes above and half below the face", () => {
    const m = cellMetrics({ advance: 10, ascent: 20, descent: -5, lineGap: 4 });
    expect(m.cellH).toBe(29);
    expect(m.baseline).toBe(22); // 2 (half gap) + 20 (ascent)
  });

  test("a face whose line height rounds down still centers the baseline", () => {
    // faceH = 25.4 → cellH 25; the 0.4 loss is split, so the baseline shifts by 0.2 before rounding
    const m = cellMetrics({ advance: 10, ascent: 20.4, descent: -5, lineGap: 0 });
    expect(m.cellH).toBe(25);
    expect(m.baseline).toBe(20);
  });

  test("never produces a zero-sized cell or stroke", () => {
    const m = cellMetrics({ advance: 0.2, ascent: 0.3, descent: 0, lineGap: 0 });
    expect(m.cellW).toBe(1);
    expect(m.cellH).toBe(1);
    expect(m.underlineThickness).toBe(1);
    expect(m.strikethroughThickness).toBe(1);
    expect(m.boxThickness).toBe(1);
    expect(m.cursorThickness).toBe(1);
  });

  test("rejects a face that cannot have come from a font", () => {
    expect(() => cellMetrics({ advance: -1, ascent: 20, descent: -5, lineGap: 0 })).toThrow(
      "advance",
    );
    expect(() => cellMetrics({ advance: 10, ascent: NaN, descent: -5, lineGap: 0 })).toThrow(
      "ascent",
    );
  });
});

describe("knownFace", () => {
  test("JetBrains Mono's table metrics (post, OS/2) scale with the pixel size", () => {
    const face = knownFace('"JetBrains Mono", ui-monospace, monospace', 30);
    expect(face).toEqual({
      underlinePosition: -4.65,
      underlineThickness: 1.5,
      strikethroughPosition: 9.6,
      strikethroughThickness: 1.5,
      capHeight: 21.9,
      exHeight: 16.5,
    });
  });

  test("an unknown family yields nothing, so measured estimates apply", () => {
    expect(knownFace("Menlo, monospace", 30)).toEqual({});
  });
});
