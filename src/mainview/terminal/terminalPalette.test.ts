import { describe, expect, test } from "bun:test";
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from "../ansi";
import { hexToRgb, paletteFor } from "./terminalPalette";

describe("hexToRgb", () => {
  test("parses #rrggbb into a byte triple", () => {
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#0a0e11")).toEqual([10, 14, 17]);
    expect(hexToRgb("#fc4926")).toEqual([252, 73, 38]);
  });
});

describe("paletteFor", () => {
  test("dark theme is light text on a near-black ground", () => {
    const p = paletteFor("dark");
    expect(p.fg).toEqual(hexToRgb(DARK_TERMINAL_THEME.foreground));
    expect(p.bg).toEqual(hexToRgb(DARK_TERMINAL_THEME.background));
    expect(p.cursor).toEqual(hexToRgb(DARK_TERMINAL_THEME.cursor));
    // fg is bright, bg is dark
    expect(p.fg[0] + p.fg[1] + p.fg[2]).toBeGreaterThan(p.bg[0] + p.bg[1] + p.bg[2]);
  });

  test("light theme inverts: dark ink on paper", () => {
    const p = paletteFor("light");
    expect(p.bg).toEqual(hexToRgb(LIGHT_TERMINAL_THEME.background));
    // paper is bright, ink is dark — the opposite of dark mode
    expect(p.bg[0] + p.bg[1] + p.bg[2]).toBeGreaterThan(p.fg[0] + p.fg[1] + p.fg[2]);
  });
});
