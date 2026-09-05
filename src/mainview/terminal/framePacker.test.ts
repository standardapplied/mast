import { describe, expect, test } from "bun:test";
import {
  type AtlasLike,
  BG_STRIDE,
  FG_PER_CELL,
  FG_STRIDE,
  type FrameColors,
  packFrame,
} from "./framePacker";
import type { GlyphStyle } from "./glyphAtlas";
import type { SpecialKind } from "./sprites/special";
import { TerminalGrid } from "./terminalGrid";
import type { Cell, Cursor, Rgb } from "./vtCore";

/** Hands out ids by name and remembers each, so a packed instance reads back as intent. */
class StubAtlas implements AtlasLike {
  readonly names: string[] = ["blank"];
  private readonly ids = new Map<string, number>();
  glyph(text: string, style: GlyphStyle, wide: boolean): number {
    if (text === "" || text === " ") return 0;
    const face = `${style.bold ? ":bold" : ""}${style.italic ? ":italic" : ""}`;
    return this.id(`glyph:${text}${face}${wide ? ":wide" : ""}`);
  }
  special(kind: SpecialKind, wide: boolean): number {
    return this.id(`${kind}${wide ? ":wide" : ""}`);
  }
  cell(id: number) {
    return { u: id, v: 0 };
  }
  isColor(id: number): boolean {
    return this.names[id]?.startsWith("glyph:😀") ?? false;
  }
  private id(name: string): number {
    let id = this.ids.get(name);
    if (id === undefined) {
      id = this.names.length;
      this.names.push(name);
      this.ids.set(name, id);
    }
    return id;
  }
}

const FG: Rgb = [200, 210, 220];
const BG: Rgb = [10, 20, 30];
const COLORS: FrameColors = {
  bg: BG,
  cursor: [255, 0, 0],
  selectionBg: [0, 0, 255],
  selectionFg: [255, 255, 255],
};

function cell(text: string, extra: Partial<Cell> = {}): Cell {
  return {
    text,
    fg: FG,
    bg: BG,
    bold: false,
    italic: false,
    underline: "none",
    underlineColor: null,
    strikethrough: false,
    overline: false,
    faint: false,
    invisible: false,
    selected: false,
    width: 1,
    ...extra,
  };
}

const NO_CURSOR: Cursor = {
  present: false,
  x: 0,
  y: 0,
  visible: false,
  style: "block",
  blinking: false,
};

const at = (x: number, style: Cursor["style"], visible = true): Cursor => ({
  present: true,
  x,
  y: 0,
  visible,
  style,
  blinking: style !== "block",
});

function pack(cells: Cell[], cursor = NO_CURSOR) {
  const grid = new TerminalGrid({ fg: FG, bg: BG });
  grid.resize(cells.length, 1);
  grid.apply({ dirty: "full", rows: [{ y: 0, cells }] });
  const atlas = new StubAtlas();
  const out = {
    bg: new Float32Array(cells.length * BG_STRIDE),
    fg: new Float32Array((cells.length * FG_PER_CELL + 1) * FG_STRIDE),
  };
  const count = packFrame(grid, cursor, atlas, COLORS, out);
  const instances = Array.from({ length: count }, (_, i) => {
    const o = i * FG_STRIDE;
    return {
      x: out.fg[o],
      what: atlas.names[out.fg[o + 5]!],
      color: [out.fg[o + 2]! * 255, out.fg[o + 3]! * 255, out.fg[o + 4]! * 255].map(Math.round),
      w: out.fg[o + 7],
      mode: out.fg[o + 8],
    };
  });
  const bg = Array.from({ length: cells.length }, (_, x) => {
    const o = x * BG_STRIDE;
    return [out.bg[o]! * 255, out.bg[o + 1]! * 255, out.bg[o + 2]! * 255].map(Math.round);
  });
  return { instances, bg };
}

describe("packFrame", () => {
  test("a plain cell is one glyph instance in its own color over its own background", () => {
    const { instances, bg } = pack([cell("a")]);
    expect(bg).toEqual([[10, 20, 30]]);
    expect(instances).toEqual([{ x: 0, what: "glyph:a", color: [200, 210, 220], w: 1, mode: 0 }]);
  });

  test("blank cells cost no foreground instance", () => {
    expect(pack([cell(" "), cell("")]).instances).toEqual([]);
  });

  test("decorations come before the glyph so text layers over them", () => {
    const { instances } = pack([
      cell("u", { underline: "curly", strikethrough: true, overline: true }),
    ]);
    expect(instances.map((i) => i.what)).toEqual([
      "underline_curly",
      "strikethrough",
      "overline",
      "glyph:u",
    ]);
  });

  test("each underline style maps to its sprite", () => {
    for (const [style, sprite] of [
      ["single", "underline"],
      ["double", "underline_double"],
      ["dotted", "underline_dotted"],
      ["dashed", "underline_dashed"],
    ] as const) {
      expect(pack([cell("x", { underline: style })]).instances[0]!.what).toBe(sprite);
    }
  });

  test("an SGR 58 underline color applies to the underline only", () => {
    const { instances } = pack([cell("x", { underline: "single", underlineColor: [1, 2, 3] })]);
    expect(instances[0]).toMatchObject({ what: "underline", color: [1, 2, 3] });
    expect(instances[1]).toMatchObject({ what: "glyph:x", color: [200, 210, 220] });
  });

  test("faint dims the glyph and its decorations halfway toward the background", () => {
    const { instances } = pack([cell("f", { faint: true, strikethrough: true })]);
    expect(instances.map((i) => i.color)).toEqual([
      [105, 115, 125],
      [105, 115, 125],
    ]);
  });

  test("invisible text keeps its decorations but draws no glyph", () => {
    const { instances } = pack([cell("s", { invisible: true, underline: "single" })]);
    expect(instances.map((i) => i.what)).toEqual(["underline"]);
  });

  test("bold and italic reach the atlas as the glyph's face", () => {
    const { instances } = pack([cell("b", { bold: true, italic: true })]);
    expect(instances[0]!.what).toBe("glyph:b:bold:italic");
  });

  test("a wide glyph spans two cells once; its spacer adds nothing", () => {
    const { instances } = pack([
      cell("世", { width: 2, underline: "single" }),
      cell("", { underline: "single" }),
      cell("z"),
    ]);
    expect(instances).toEqual([
      expect.objectContaining({ x: 0, what: "underline:wide", w: 2 }),
      expect.objectContaining({ x: 0, what: "glyph:世:wide", w: 2 }),
      expect.objectContaining({ x: 2, what: "glyph:z", w: 1 }),
    ]);
  });

  test("a color glyph is drawn in color mode", () => {
    const { instances } = pack([cell("😀", { width: 2 }), cell("")]);
    expect(instances).toEqual([expect.objectContaining({ what: "glyph:😀:wide", mode: 1 })]);
  });

  test("a block cursor swaps the cell to the cursor color and draws text in the background", () => {
    const { instances, bg } = pack(
      [cell("a"), cell("b", { underline: "single", underlineColor: [9, 9, 9] })],
      at(1, "block"),
    );
    expect(bg[1]).toEqual([255, 0, 0]);
    expect(instances.filter((i) => i.x === 1)).toEqual([
      expect.objectContaining({ what: "underline", color: [10, 20, 30] }),
      expect.objectContaining({ what: "glyph:b", color: [10, 20, 30] }),
    ]);
  });

  test("bar, underline and hollow cursors are a sprite drawn last in the cursor color", () => {
    for (const [style, sprite] of [
      ["bar", "cursor_bar"],
      ["underline", "cursor_underline"],
      ["hollow", "cursor_hollow"],
    ] as const) {
      const { instances, bg } = pack([cell("a")], at(0, style));
      expect(bg[0]).toEqual([10, 20, 30]);
      expect(instances.at(-1)).toEqual({ x: 0, what: sprite, color: [255, 0, 0], w: 1, mode: 0 });
      expect(instances[0]).toMatchObject({ what: "glyph:a", color: [200, 210, 220] });
    }
  });

  test("a cursor on a wide glyph spans both cells", () => {
    const { instances } = pack([cell("世", { width: 2 }), cell("")], at(0, "hollow"));
    expect(instances.at(-1)).toMatchObject({ what: "cursor_hollow:wide", w: 2 });
  });

  test("a hidden or absent cursor draws nothing extra", () => {
    expect(pack([cell("a")], at(0, "bar", false)).instances).toHaveLength(1);
    expect(pack([cell("a")], NO_CURSOR).instances).toHaveLength(1);
  });

  test("a selected cell recolors background and text; the block cursor cell wins", () => {
    const { instances, bg } = pack(
      [cell("a", { selected: true }), cell("b", { selected: true })],
      at(0, "block"),
    );
    expect(bg).toEqual([
      [255, 0, 0],
      [0, 0, 255],
    ]);
    expect(instances[1]).toMatchObject({ what: "glyph:b", color: [255, 255, 255] });
  });
});
