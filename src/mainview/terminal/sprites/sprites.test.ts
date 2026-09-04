import { describe, expect, test } from "bun:test";
import { opInside, type RasterOp, RasterStub } from "../../../../test/rasterStub";
import { drawSprite, type SpriteMetrics, spriteCodepoint } from "./index";

const M: SpriteMetrics = { cellW: 18, cellH: 40, boxThickness: 2 };

function draw(ch: string, m: SpriteMetrics = M): RasterOp[] {
  const r = new RasterStub(m.cellW, m.cellH, { advance: 18, ascent: 30, descent: 10 });
  drawSprite(ch.codePointAt(0)!, r, m);
  return r.ops;
}

const rects = (ops: RasterOp[]) =>
  ops.flatMap((o) => (o.kind === "fillRect" ? [[o.x, o.y, o.w, o.h]] : []));

describe("spriteCodepoint", () => {
  test("recognizes single box, block and braille codepoints only", () => {
    expect(spriteCodepoint("│")).toBe(0x2502);
    expect(spriteCodepoint("█")).toBe(0x2588);
    expect(spriteCodepoint("⠋")).toBe(0x280b);
    expect(spriteCodepoint("A")).toBeNull();
    expect(spriteCodepoint("⎿")).toBeNull(); // U+23BF is not in a sprite range
    expect(spriteCodepoint("")).toBeNull();
    expect(spriteCodepoint("│x")).toBeNull(); // a cluster, not a single codepoint
  });
});

describe("box drawing", () => {
  test("│ is a centered light stroke: an up arm and a down arm that overlap at the middle", () => {
    expect(rects(draw("│"))).toEqual([
      [8, 0, 2, 21],
      [8, 19, 2, 21],
    ]);
  });

  test("─ reaches both edges; ━ is twice as thick", () => {
    expect(rects(draw("─"))).toEqual([
      [8, 19, 10, 2],
      [0, 19, 10, 2],
    ]);
    expect(rects(draw("━"))).toEqual([
      [8, 18, 10, 4],
      [0, 18, 10, 4],
    ]);
  });

  test("┼ meets in the middle with every arm reaching its edge", () => {
    const r = rects(draw("┼"));
    expect(r).toContainEqual([8, 0, 2, 21]); // up
    expect(r).toContainEqual([8, 19, 2, 21]); // down
    expect(r).toContainEqual([0, 19, 10, 2]); // left
    expect(r).toContainEqual([8, 19, 10, 2]); // right
  });

  test("┌ starts at the center and reaches the right and bottom edges", () => {
    expect(rects(draw("┌"))).toEqual([
      [8, 19, 10, 2], // right, from the vertical's left edge
      [8, 19, 2, 21], // down, from the horizontal's top edge
    ]);
  });

  test("═ and ║ are two parallel light strokes around the center", () => {
    expect(new Set(rects(draw("═")).map(String))).toEqual(
      new Set([[8, 17, 10, 2], [8, 21, 10, 2], [0, 17, 10, 2], [0, 21, 10, 2]].map(String)),
    );
    expect(new Set(rects(draw("║")).map(String))).toEqual(
      new Set([[6, 0, 2, 21], [10, 0, 2, 21], [6, 19, 2, 21], [10, 19, 2, 21]].map(String)),
    );
  });

  test("╭ strokes a path from the bottom edge, through the center, to the right edge", () => {
    const ops = draw("╭");
    expect(ops).toHaveLength(1);
    const stroke = ops[0]!;
    if (stroke.kind !== "stroke") throw new Error("expected a stroke");
    expect(stroke.lineWidth).toBe(2);
    expect(stroke.points[0]).toEqual([9, 40]); // bottom edge, centered
    expect(stroke.points.at(-1)).toEqual([18, 20]); // right edge, centered
  });

  test("┄ draws three dashes with half gaps at both edges, filling the width exactly", () => {
    const r = rects(draw("┄"));
    expect(r).toHaveLength(3);
    // gap = min(4, floor(18/6)) = 3; dash total = 18 − 9 = 9 → 3 each; starts at half a gap
    expect(r).toEqual([
      [1, 19, 3, 2],
      [7, 19, 3, 2],
      [13, 19, 3, 2],
    ]);
  });

  test("╱ strokes corner to corner", () => {
    const ops = draw("╱");
    expect(ops).toHaveLength(1);
    const stroke = ops[0]!;
    if (stroke.kind !== "stroke") throw new Error("expected a stroke");
    expect(stroke.points[0]![0]).toBeGreaterThan(18); // overshoots the top-right corner slightly
    expect(stroke.points[1]![1]).toBeGreaterThan(40);
  });

  test("a 1×1 cell still draws without inverted boxes", () => {
    const tiny: SpriteMetrics = { cellW: 1, cellH: 1, boxThickness: 1 };
    for (const ch of ["┼", "═", "║", "┄", "╋"]) {
      for (const [, , w, h] of rects(draw(ch, tiny))) {
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
      }
    }
  });
});

describe("block elements", () => {
  test("█ fills the cell; ▀ and ▄ split it without a seam", () => {
    expect(rects(draw("█"))).toEqual([[0, 0, 18, 40]]);
    expect(rects(draw("▀"))).toEqual([[0, 0, 18, 20]]);
    expect(rects(draw("▄"))).toEqual([[0, 20, 18, 20]]);
  });

  test("▌ and ▐ split the width; ▏ is one eighth", () => {
    expect(rects(draw("▌"))).toEqual([[0, 0, 9, 40]]);
    expect(rects(draw("▐"))).toEqual([[9, 0, 9, 40]]);
    expect(rects(draw("▏"))).toEqual([[0, 0, 2, 40]]);
  });

  test("at an odd height, ▀ and ▄ hug their edges and meet without a gap", () => {
    const odd: SpriteMetrics = { cellW: 17, cellH: 39, boxThickness: 2 };
    const upper = rects(draw("▀", odd))[0]!;
    const lower = rects(draw("▄", odd))[0]!;
    expect(upper[1]).toBe(0);
    expect(lower[1]! + lower[3]!).toBe(39);
    expect(lower[1]).toBeLessThanOrEqual(upper[1]! + upper[3]!);
  });

  test("shades are translucent full cells and leave the fill style as they found it", () => {
    const r = new RasterStub(18, 40, { advance: 18, ascent: 30, descent: 10 });
    r.fillStyle = "#fff";
    drawSprite(0x2592, r, M);
    expect(r.ops).toEqual([
      { kind: "fillRect", x: 0, y: 0, w: 18, h: 40, fillStyle: "rgba(255,255,255,0.502)" },
    ]);
    expect(r.fillStyle).toBe("#fff");
  });

  test("quadrants: ▚ is top-left and bottom-right", () => {
    expect(rects(draw("▚"))).toEqual([
      [0, 0, 9, 20],
      [9, 20, 9, 20],
    ]);
  });
});

describe("braille", () => {
  test("⠋ (dots 1,2,4) lights the left column's top two and the right column's top dot", () => {
    const r = rects(draw("⠋"));
    expect(r).toHaveLength(3);
    const [a, b, c] = r;
    expect(a![0]).toBe(b![0]); // same left column
    expect(a![1]).toBeLessThan(b![1]!);
    expect(c![0]).toBeGreaterThan(a![0]!); // right column
    expect(c![1]).toBe(a![1]); // top row
  });

  test("⣿ lights all eight dots inside the cell on a 2×4 grid", () => {
    const r = rects(draw("⣿"));
    expect(r).toHaveLength(8);
    expect(new Set(r.map((d) => d[0])).size).toBe(2);
    expect(new Set(r.map((d) => d[1])).size).toBe(4);
    for (const [x, y, w, h] of r) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x! + w!).toBeLessThanOrEqual(18);
      expect(y! + h!).toBeLessThanOrEqual(40);
    }
  });

  test("⠀ (blank pattern) draws nothing", () => {
    expect(draw("⠀")).toEqual([]);
  });
});

describe("every sprite stays inside its cell", () => {
  const ranges: [number, number][] = [
    [0x2500, 0x257f],
    [0x2580, 0x259f],
    [0x2800, 0x28ff],
  ];
  const sizes: SpriteMetrics[] = [
    M,
    { cellW: 7, cellH: 15, boxThickness: 1 },
    { cellW: 30, cellH: 60, boxThickness: 3 },
  ];
  for (const m of sizes) {
    test(`at ${m.cellW}×${m.cellH}, every filled rect lies within the cell`, () => {
      const cell = { x: 0, y: 0, w: m.cellW, h: m.cellH };
      for (const [first, last] of ranges) {
        for (let cp = first; cp <= last; cp++) {
          const r = new RasterStub(m.cellW, m.cellH, { advance: 1, ascent: 1, descent: 0 });
          drawSprite(cp, r, m);
          for (const op of r.ops) {
            if (op.kind === "fillRect") {
              expect(opInside(op, cell)).toBe(true);
            }
          }
        }
      }
    });
  }
});
