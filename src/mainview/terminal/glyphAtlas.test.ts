import { describe, expect, test } from "bun:test";
import { opInside, type RasterOp, type Rect, rasterStubFactory } from "../../../test/rasterStub";
import { GlyphAtlas } from "./glyphAtlas";

/** JetBrains Mono at 15 CSS px × 2, as a 2D context measures it. */
const FACE = { advance: 18, ascent: 30.6, descent: 9, capHeight: 21.9, exHeight: 16.5 };
const FAMILY = '"JetBrains Mono", monospace';

function atlas(opts: { colored?: string[]; cols?: number; rows?: number } = {}) {
  const raster = rasterStubFactory(FACE, new Set(opts.colored ?? []));
  const a = new GlyphAtlas(raster, FAMILY, 15, 2, opts.cols ?? 64, opts.rows ?? 64);
  // surfaces[0] is the measuring probe; surfaces[1] is the atlas bitmap.
  const ops = () => raster.surfaces[1]!.ops;
  return { a, ops, raster };
}

function slotOf(a: GlyphAtlas, id: number, span = 1): Rect {
  const { u, v } = a.cell(id);
  const { cellW, cellH } = a.metrics;
  return { x: u * cellW, y: v * cellH, w: span * cellW, h: cellH };
}

const PLAIN = { bold: false, italic: false };

describe("GlyphAtlas", () => {
  test("derives its cell from the measured face and the known table metrics", () => {
    const { a } = atlas();
    expect(a.metrics).toEqual({
      cellW: 18,
      cellH: 40,
      baseline: 31,
      underlinePosition: 36,
      underlineThickness: 2,
      strikethroughPosition: 21,
      strikethroughThickness: 2,
      boxThickness: 2,
      cursorThickness: 2,
    });
    expect(a.width).toBe(64 * 18);
    expect(a.height).toBe(64 * 40);
  });

  test("rasterizes a glyph once, at the baseline, clipped to its own slot", () => {
    const { a, ops } = atlas();
    const id = a.glyph("A", PLAIN);
    expect(id).toBe(1);
    const slot = slotOf(a, id);
    const text = ops().find((o) => o.kind === "fillText");
    expect(text).toEqual({
      kind: "fillText",
      text: "A",
      x: slot.x,
      y: slot.y + 31,
      font: `30px ${FAMILY}`,
      clip: slot,
    });
    const before = a.version;
    expect(a.glyph("A", PLAIN)).toBe(1);
    expect(a.version).toBe(before);
    expect(ops().filter((o) => o.kind === "fillText")).toHaveLength(1);
  });

  test("blank text is glyph 0 and draws nothing", () => {
    const { a, ops } = atlas();
    expect(a.glyph(" ", PLAIN)).toBe(0);
    expect(a.glyph("", PLAIN)).toBe(0);
    expect(ops()).toEqual([]);
  });

  test("bold and italic pick the face; each styled variant is its own slot", () => {
    const { a, ops } = atlas();
    const bold = a.glyph("A", { ...PLAIN, bold: true });
    const italic = a.glyph("A", { ...PLAIN, italic: true });
    expect(new Set([a.glyph("A", PLAIN), bold, italic]).size).toBe(3);
    const fonts = ops().flatMap((o) => (o.kind === "fillText" ? [o.font] : []));
    expect(fonts).toEqual([`bold 30px ${FAMILY}`, `italic 30px ${FAMILY}`, `30px ${FAMILY}`]);
  });

  test("box, block and braille glyphs come from the sprite face, never the font", () => {
    const { a, ops } = atlas();
    const id = a.glyph("│", PLAIN);
    const slot = slotOf(a, id);
    expect(ops().some((o) => o.kind === "fillText")).toBe(false);
    const rects = ops().filter((o) => o.kind === "fillRect");
    expect(rects).toHaveLength(2);
    for (const op of rects) expect(opInside(op, slot)).toBe(true);
    expect(rects[0]).toMatchObject({ x: slot.x + 8, y: slot.y, w: 2 });
  });

  test("decoration sprites are slots of their own, drawn at the face's positions", () => {
    const { a, ops } = atlas();
    const underline = a.special("underline");
    const strike = a.special("strikethrough", true);
    expect(underline).not.toBe(strike);
    expect(a.special("underline")).toBe(underline);
    const u = slotOf(a, underline);
    const s = slotOf(a, strike, 2);
    expect(ops()).toEqual([
      { kind: "fillRect", x: u.x, y: u.y + 36, w: 18, h: 2, fillStyle: "#fff" },
      { kind: "fillRect", x: s.x, y: s.y + 21, w: 36, h: 2, fillStyle: "#fff" },
    ]);
    expect(a.isColor(underline)).toBe(false);
  });

  test("a wide glyph takes two slots in one row and is clipped to both", () => {
    const { a, ops } = atlas({ cols: 4, rows: 4 });
    a.glyph("A", PLAIN); // id 1
    a.glyph("B", PLAIN); // id 2
    const wide = a.glyph("世", PLAIN, true); // would straddle the row end at 3 → skips to 4
    expect(wide).toBe(4);
    expect(a.cell(wide)).toEqual({ u: 0, v: 1 });
    const text = ops().find((o) => o.kind === "fillText" && o.text === "世");
    expect(text).toMatchObject({ clip: slotOf(a, wide, 2) });
    expect(a.glyph("C", PLAIN)).toBe(6);
  });

  test("a color glyph (emoji) is flagged so the renderer draws it untinted", () => {
    const { a } = atlas({ colored: ["😀"] });
    const emoji = a.glyph("😀", PLAIN, true);
    const letter = a.glyph("A", PLAIN);
    expect(a.isColor(emoji)).toBe(true);
    expect(a.isColor(letter)).toBe(false);
    expect(a.isColor(0)).toBe(false);
  });

  test("a full atlas yields blank rather than overwriting a slot", () => {
    const { a } = atlas({ cols: 2, rows: 2 });
    expect(a.glyph("A", PLAIN)).toBe(1);
    expect(a.glyph("B", PLAIN)).toBe(2);
    expect(a.glyph("C", PLAIN)).toBe(3);
    expect(a.glyph("D", PLAIN)).toBe(0);
    expect(a.glyph("A", PLAIN)).toBe(1);
  });

  test("no draw for any glyph can reach outside its own slot", () => {
    const { a, ops } = atlas({ colored: ["😀"] });
    const samples: [string, boolean][] = [
      ["A", false],
      ["g", false],
      ["│", false],
      ["╭", false],
      ["█", false],
      ["╱", false],
      ["⣿", false],
      ["世", true],
      ["😀", true],
      ["f", false],
    ];
    const slots = new Map<number, Rect>();
    for (const [text, wide] of samples) {
      const id = a.glyph(text, { bold: false, italic: true }, wide);
      slots.set(id, slotOf(a, id, wide ? 2 : 1));
    }
    for (const kind of ["underline_curly", "underline_dotted", "cursor_hollow"] as const) {
      const id = a.special(kind, true);
      slots.set(id, slotOf(a, id, 2));
    }
    const drawn: RasterOp[] = ops();
    expect(drawn.length).toBeGreaterThan(samples.length);
    for (const op of drawn) {
      expect([...slots.values()].some((slot) => opInside(op, slot))).toBe(true);
    }
  });

  test("pixels() reads the whole bitmap back", () => {
    const { a } = atlas({ cols: 2, rows: 2 });
    expect(a.pixels().length).toBe(a.width * a.height * 4);
  });

  test("fails loudly when the raster cannot report face metrics", () => {
    const raster = rasterStubFactory({ advance: 18, ascent: Number.NaN, descent: 9 });
    expect(() => new GlyphAtlas(raster, FAMILY, 15, 2)).toThrow("ascent");
  });
});
