import { describe, expect, test } from "bun:test";
import { Selection, selectedText } from "./selection";

const rows = (lines: string[]): string[][] => lines.map((l) => [...l.padEnd(10, " ")]);

describe("Selection.contains", () => {
  test("a single-row range covers the cells between anchor and focus inclusive", () => {
    const sel = new Selection({ x: 2, y: 0 }, { x: 5, y: 0 }, 10);
    expect([1, 2, 3, 4, 5, 6].map((x) => sel.contains(x, 0))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  test("is order-independent (drag left-to-right or right-to-left)", () => {
    const a = new Selection({ x: 5, y: 0 }, { x: 2, y: 0 }, 10);
    const b = new Selection({ x: 2, y: 0 }, { x: 5, y: 0 }, 10);
    for (let x = 0; x < 10; x++) expect(a.contains(x, 0)).toBe(b.contains(x, 0));
  });

  test("a multi-row range fills whole middle rows, partial first/last", () => {
    const sel = new Selection({ x: 7, y: 0 }, { x: 3, y: 2 }, 10);
    expect(sel.contains(6, 0)).toBe(false); // before the anchor on row 0
    expect(sel.contains(7, 0)).toBe(true);
    expect(sel.contains(0, 1)).toBe(true); // whole middle row
    expect(sel.contains(9, 1)).toBe(true);
    expect(sel.contains(3, 2)).toBe(true);
    expect(sel.contains(4, 2)).toBe(false); // past the focus on the last row
  });

  test("a click without a drag is empty", () => {
    expect(new Selection({ x: 4, y: 1 }, { x: 4, y: 1 }, 10).isEmpty).toBe(true);
    expect(new Selection({ x: 4, y: 1 }, { x: 5, y: 1 }, 10).isEmpty).toBe(false);
  });
});

describe("selectedText", () => {
  test("extracts one line, trimming trailing blanks", () => {
    const sel = new Selection({ x: 0, y: 0 }, { x: 9, y: 0 }, 10);
    expect(selectedText(sel, rows(["hello"]))).toBe("hello");
  });

  test("joins multi-row selections with newlines, middle rows whole", () => {
    const grid = rows(["abcdefghij", "  middle  ", "xy"]);
    const sel = new Selection({ x: 8, y: 0 }, { x: 1, y: 2 }, 10);
    expect(selectedText(sel, grid)).toBe("ij\n  middle\nxy");
  });
});
