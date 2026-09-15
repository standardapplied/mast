import { describe, expect, test } from "bun:test";
import { type ChordKeys, paneChordOf } from "./paneChords";

const press = (init: Partial<ChordKeys>): ChordKeys => ({
  key: "",
  code: "",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe("paneChordOf", () => {
  test("Ghostty's tab and split chords, by physical key where the layout could move them", () => {
    expect(paneChordOf(press({ key: "t", code: "KeyT" }))).toEqual({ kind: "new" });
    expect(paneChordOf(press({ key: "D", code: "KeyD", shiftKey: true }))).toEqual({ kind: "split" });
    expect(paneChordOf(press({ key: "1", code: "Digit1" }))).toEqual({ kind: "group", index: 0 });
    expect(paneChordOf(press({ key: "&", code: "Digit8" }))).toEqual({ kind: "group", index: 7 });
    expect(paneChordOf(press({ key: "9", code: "Digit9" }))).toEqual({ kind: "lastGroup" });
    expect(paneChordOf(press({ key: "{", code: "BracketLeft", shiftKey: true }))).toEqual({
      kind: "cycleGroup",
      delta: -1,
    });
    expect(paneChordOf(press({ key: "ü", code: "BracketRight", shiftKey: true }))).toEqual({
      kind: "cycleGroup",
      delta: 1,
    });
    expect(paneChordOf(press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toEqual({
      kind: "focusPane",
      delta: -1,
    });
    expect(paneChordOf(press({ key: "ArrowRight", code: "ArrowRight", altKey: true }))).toEqual({
      kind: "focusPane",
      delta: 1,
    });
    expect(paneChordOf(press({ key: "w", code: "KeyW" }))).toEqual({ kind: "closePane" });
    expect(paneChordOf(press({ key: "W", code: "KeyW", shiftKey: true }))).toEqual({ kind: "closeGroup" });
  });

  test("what is not a chord: plain ⌘ arrows, ⌥-only, Ctrl, ⌘0, unshifted brackets, ⌘⌥↑/↓", () => {
    const none = [
      press({ key: "ArrowLeft", code: "ArrowLeft" }),
      press({ key: "ArrowRight", code: "ArrowRight", metaKey: false, altKey: true }),
      press({ key: "w", code: "KeyW", ctrlKey: true }),
      press({ key: "t", code: "KeyT", metaKey: false }),
      press({ key: "0", code: "Digit0" }),
      press({ key: "!", code: "Digit1", shiftKey: true }),
      press({ key: "]", code: "BracketRight" }),
      press({ key: "ArrowUp", code: "ArrowUp", altKey: true }),
      press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true }),
      press({ key: "Dead", code: "KeyW" }),
    ];
    for (const keys of none) expect(paneChordOf(keys), JSON.stringify(keys)).toBeNull();
  });
});
