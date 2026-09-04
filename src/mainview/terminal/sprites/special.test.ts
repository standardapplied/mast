import { describe, expect, test } from "bun:test";
import { opInside, type RasterOp, RasterStub } from "../../../../test/rasterStub";
import type { CellMetrics } from "../fontMetrics";
import { drawSpecial, SPECIAL_KINDS, type SpecialKind } from "./special";

/** JetBrains Mono at 30 device px, as fontMetrics derives it. */
const M: CellMetrics = {
  cellW: 18,
  cellH: 40,
  baseline: 31,
  underlinePosition: 36,
  underlineThickness: 2,
  strikethroughPosition: 21,
  strikethroughThickness: 2,
  boxThickness: 2,
  cursorThickness: 2,
};

function draw(kind: SpecialKind, width = M.cellW, m = M): RasterOp[] {
  const r = new RasterStub(width, m.cellH, { advance: 18, ascent: 30, descent: 10 });
  drawSpecial(kind, r, m, width);
  return r.ops;
}
const rects = (ops: RasterOp[]) =>
  ops.flatMap((o) => (o.kind === "fillRect" ? [[o.x, o.y, o.w, o.h]] : []));

describe("decoration sprites", () => {
  test("underline is one rule at the face's position, full width", () => {
    expect(rects(draw("underline"))).toEqual([[0, 36, 18, 2]]);
    expect(rects(draw("underline", 36))).toEqual([[0, 36, 36, 2]]);
  });

  test("a face whose underline would fall off the cell is pulled up to fit", () => {
    const low = { ...M, underlinePosition: 39 };
    expect(rects(draw("underline", 18, low))).toEqual([[0, 38, 18, 2]]);
    expect(rects(draw("underline_double", 18, low))).toEqual([
      [0, 34, 18, 2],
      [0, 38, 18, 2],
    ]);
  });

  test("double underline brackets the single position with two rules", () => {
    expect(rects(draw("underline_double"))).toEqual([
      [0, 34, 18, 2],
      [0, 38, 18, 2],
    ]);
  });

  test("dotted underline spaces even dots across the width", () => {
    const dots = rects(draw("underline_dotted"));
    // radius = √½·2 ≈ 1.41; count = max(1, min(ceil(18/5.66)=4, floor(18/4.24)=4, floor(18/3.83)=4))
    expect(dots).toHaveLength(4);
    const centers = dots.map((d) => d[0]! + d[2]! / 2);
    expect(centers.map((c) => Math.round(c * 100) / 100)).toEqual([2.25, 6.75, 11.25, 15.75]);
    for (const d of dots) expect(d[1]! + d[3]!).toBeLessThanOrEqual(40);
  });

  test("dashed underline alternates dash and gap from the left edge", () => {
    // dash = floor(18/3)+1 = 7; count = floor(18/7)+1 = 3 → dashes at i=0,2 → [0,7) and [14,18)
    expect(rects(draw("underline_dashed"))).toEqual([
      [0, 36, 7, 2],
      [14, 36, 4, 2],
    ]);
  });

  test("curly underline is one stroked wave across the width with round caps", () => {
    const ops = draw("underline_curly");
    expect(ops).toHaveLength(1);
    const stroke = ops[0]!;
    if (stroke.kind !== "stroke") throw new Error("expected a stroke");
    expect(stroke.lineWidth).toBe(2);
    expect(stroke.points[0]![0]).toBe(0);
    expect(stroke.points.at(-1)![0]).toBe(18);
  });

  test("strikethrough and overline sit at their metric rows", () => {
    expect(rects(draw("strikethrough"))).toEqual([[0, 21, 18, 2]]);
    expect(rects(draw("overline"))).toEqual([[0, 0, 18, 2]]);
  });
});

describe("cursor sprites", () => {
  test("hollow block is a frame of four edges, cursor-thickness wide", () => {
    expect(rects(draw("cursor_hollow"))).toEqual([
      [0, 0, 18, 2],
      [0, 38, 18, 2],
      [0, 2, 2, 36],
      [16, 2, 2, 36],
    ]);
  });

  test("bar hugs the cell's left edge; underline cursor sits on the underline row", () => {
    expect(rects(draw("cursor_bar"))).toEqual([[0, 0, 2, 40]]);
    expect(rects(draw("cursor_underline"))).toEqual([[0, 36, 18, 2]]);
  });
});

describe("every special sprite stays inside its cell", () => {
  for (const width of [18, 36]) {
    test(`at width ${width}`, () => {
      const cell = { x: 0, y: 0, w: width, h: M.cellH };
      for (const kind of SPECIAL_KINDS) {
        for (const op of draw(kind, width)) {
          if (op.kind === "fillRect") expect(opInside(op, cell)).toBe(true);
        }
      }
    });
  }
});
