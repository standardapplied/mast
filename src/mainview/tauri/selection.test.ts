import { describe, expect, test } from "bun:test";
import { clearSelection, click, EMPTY_SELECTION, rangeTo, toggle } from "./selection";

const visible = ["/a", "/b", "/c", "/d", "/e"];

describe("selection model", () => {
  test("plain click selects exactly one and sets the anchor", () => {
    const sel = click(EMPTY_SELECTION, "/b");
    expect([...sel.paths]).toEqual(["/b"]);
    expect(sel.anchor).toBe("/b");
    expect(sel.focus).toBe("/b");
  });

  test("click replaces any prior multi-selection", () => {
    let sel = click(EMPTY_SELECTION, "/a");
    sel = toggle(sel, "/c");
    sel = click(sel, "/d");
    expect([...sel.paths]).toEqual(["/d"]);
  });

  test("cmd-click toggles membership without dropping the rest", () => {
    let sel = click(EMPTY_SELECTION, "/a");
    sel = toggle(sel, "/c");
    expect([...sel.paths].sort()).toEqual(["/a", "/c"]);
    sel = toggle(sel, "/a");
    expect([...sel.paths]).toEqual(["/c"]);
  });

  test("cmd-click on a selected sole path empties the selection", () => {
    let sel = click(EMPTY_SELECTION, "/a");
    sel = toggle(sel, "/a");
    expect(sel.paths.size).toBe(0);
    expect(sel.anchor).toBeNull();
  });

  test("shift-click ranges from the anchor over visible rows, inclusive", () => {
    let sel = click(EMPTY_SELECTION, "/b");
    sel = rangeTo(sel, visible, "/d");
    expect([...sel.paths].sort()).toEqual(["/b", "/c", "/d"]);
    expect(sel.anchor).toBe("/b");
    expect(sel.focus).toBe("/d");
  });

  test("shift-click upward ranges backwards", () => {
    let sel = click(EMPTY_SELECTION, "/d");
    sel = rangeTo(sel, visible, "/a");
    expect([...sel.paths].sort()).toEqual(["/a", "/b", "/c", "/d"]);
  });

  test("a second shift-click re-ranges from the same anchor", () => {
    let sel = click(EMPTY_SELECTION, "/b");
    sel = rangeTo(sel, visible, "/e");
    sel = rangeTo(sel, visible, "/c");
    expect([...sel.paths].sort()).toEqual(["/b", "/c"]);
  });

  test("shift-click with no anchor behaves like a plain click", () => {
    const sel = rangeTo(EMPTY_SELECTION, visible, "/c");
    expect([...sel.paths]).toEqual(["/c"]);
    expect(sel.anchor).toBe("/c");
  });

  test("shift-click with an anchor no longer visible behaves like a plain click", () => {
    let sel = click(EMPTY_SELECTION, "/gone");
    sel = rangeTo(sel, visible, "/b");
    expect([...sel.paths]).toEqual(["/b"]);
  });

  test("clear empties everything", () => {
    let sel = click(EMPTY_SELECTION, "/a");
    sel = rangeTo(sel, visible, "/c");
    sel = clearSelection();
    expect(sel.paths.size).toBe(0);
    expect(sel.anchor).toBeNull();
    expect(sel.focus).toBeNull();
  });
});
