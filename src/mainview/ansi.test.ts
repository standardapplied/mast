import { describe, expect, test } from "bun:test";
import { DARK_TERMINAL_THEME, dimToward, LIGHT_TERMINAL_THEME, terminalTheme } from "./ansi";

const HEX = /^#[0-9a-f]{6}$/;

describe("terminal themes", () => {
  test("both themes carry 16 valid ansi colors and 16 dim variants", () => {
    for (const t of [DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME]) {
      expect(t.ansi.length).toBe(16);
      expect(t.dim.length).toBe(16);
      for (const c of [...t.ansi, ...t.dim, t.background, t.foreground, t.cursor]) {
        expect(c).toMatch(HEX);
      }
    }
  });

  test("dim variants move toward the background instead of using alpha", () => {
    const red = LIGHT_TERMINAL_THEME.ansi[1]!;
    const dimRed = LIGHT_TERMINAL_THEME.dim[1]!;
    expect(dimRed).not.toBe(red);
    expect(dimRed).toBe(dimToward(red, LIGHT_TERMINAL_THEME.background));

    const toBg = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(toBg(dimRed)).toBeGreaterThan(toBg(red));
  });

  test("dimToward blends channels linearly", () => {
    expect(dimToward("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(dimToward("#ff0000", "#000000", 0.5)).toBe("#800000");
  });

  test("terminalTheme resolves by theme name", () => {
    expect(terminalTheme("dark")).toBe(DARK_TERMINAL_THEME);
    expect(terminalTheme("light")).toBe(LIGHT_TERMINAL_THEME);
  });
});
