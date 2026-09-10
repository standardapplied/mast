import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TERMINAL_FONT_PX,
  STORAGE_KEY,
  TERMINAL_FONT_SIZES_PX,
  terminalFontSize,
} from "./fontSize";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

afterEach(() => terminalFontSize.reset());

describe("terminalFontSize", () => {
  test("defaults to the pinned terminal size, on the ladder", () => {
    expect(terminalFontSize.px()).toBe(15);
    expect(DEFAULT_TERMINAL_FONT_PX).toBe(15);
    expect(TERMINAL_FONT_SIZES_PX).toContain(DEFAULT_TERMINAL_FONT_PX);
    expect([...TERMINAL_FONT_SIZES_PX]).toEqual([...TERMINAL_FONT_SIZES_PX].sort((a, b) => a - b));
  });

  test("zoom walks the ladder one rung at a time, holds at the ends, and resets to the default", () => {
    terminalFontSize.zoom("in");
    terminalFontSize.zoom("in");
    expect(terminalFontSize.px()).toBe(17);
    for (let i = 0; i < 20; i++) terminalFontSize.zoom("in");
    expect(terminalFontSize.px()).toBe(TERMINAL_FONT_SIZES_PX.at(-1)!);
    terminalFontSize.zoom("reset");
    expect(terminalFontSize.px()).toBe(15);
    for (let i = 0; i < 20; i++) terminalFontSize.zoom("out");
    expect(terminalFontSize.px()).toBe(TERMINAL_FONT_SIZES_PX[0]);
  });

  test("connect seeds from storage and every change is written back; garbage falls to the default", () => {
    const storage = memoryStorage({ [STORAGE_KEY]: "18" });
    terminalFontSize.connect(storage);
    expect(terminalFontSize.px()).toBe(18);
    terminalFontSize.zoom("out");
    expect(storage.map.get(STORAGE_KEY)).toBe("17");

    terminalFontSize.connect(memoryStorage({ [STORAGE_KEY]: "19" }));
    expect(terminalFontSize.px(), "a size off the ladder is not a size").toBe(15);
    terminalFontSize.connect(memoryStorage({ [STORAGE_KEY]: "huge" }));
    expect(terminalFontSize.px()).toBe(15);
  });

  test("listeners hear a change and nothing for a no-op", () => {
    let heard = 0;
    const off = terminalFontSize.subscribe(() => heard++);
    terminalFontSize.zoom("reset");
    expect(heard).toBe(0);
    terminalFontSize.zoom("in");
    expect(heard).toBe(1);
    off();
    terminalFontSize.zoom("in");
    expect(heard).toBe(1);
  });
});
