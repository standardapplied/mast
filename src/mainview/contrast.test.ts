import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * WCAG AA assertions against the real token values in static/tokens.css, per
 * mode: body text >= 4.5:1, de-emphasized/subtle and UI components >= 3:1.
 * Parsing the CSS keeps a single source of truth — no duplicated palette.
 */

type RGB = { r: number; g: number; b: number };

function parseBlock(css: string, selector: string): Map<string, string> {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`No ${selector} block in tokens.css`);
  const vars = new Map<string, string>();
  for (const [, name, value] of match[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    vars.set(name!, value!.trim());
  }
  return vars;
}

function hex(value: string): RGB {
  const h = value.slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function resolve(value: string, bg: RGB): RGB {
  if (value.startsWith("#")) return hex(value);
  const m = value.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
  if (!m) throw new Error(`Unsupported color: ${value}`);
  const [, r, g, b, a] = m.map(Number);
  return {
    r: Math.round(r! * a! + bg.r * (1 - a!)),
    g: Math.round(g! * a! + bg.g * (1 - a!)),
    b: Math.round(b! * a! + bg.b * (1 - a!)),
  };
}

function luminance({ r, g, b }: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const css = await Bun.file(join(import.meta.dir, "static/tokens.css")).text();
const modes = {
  dark: parseBlock(css, ":root"),
  light: parseBlock(css, '\\[data-theme="light"\\]'),
};

const TEXT_TOKENS = [
  "foreground",
  "muted-foreground",
  "error",
  "warning",
  "success",
  "info",
  "syntax-number",
  "syntax-type",
];
const SUBTLE_TOKENS = ["subtle-foreground"];

for (const [mode, vars] of Object.entries(modes)) {
  const color = (name: string, over: RGB) => {
    const value = vars.get(name);
    if (!value) throw new Error(`--${name} missing in ${mode}`);
    return resolve(value, over);
  };

  describe(`${mode} tokens meet WCAG AA`, () => {
    const surfaces = { background: color("background", hex("#000000")), surface: undefined as unknown as RGB };
    surfaces.surface = color("surface", surfaces.background);

    for (const token of TEXT_TOKENS) {
      test(`--${token} is >= 4.5:1 on background and surface`, () => {
        for (const bg of [surfaces.background, surfaces.surface]) {
          expect(contrast(color(token, bg), bg)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }

    for (const token of SUBTLE_TOKENS) {
      test(`--${token} is >= 3:1 on background`, () => {
        const bg = surfaces.background;
        expect(contrast(color(token, bg), bg)).toBeGreaterThanOrEqual(3);
      });
    }

    test("primary button and accent meet the 3:1 UI-component floor", () => {
      const bg = surfaces.background;
      const primary = color("primary", bg);
      expect(contrast(color("on-primary", primary), primary)).toBeGreaterThanOrEqual(3);
      expect(contrast(primary, bg)).toBeGreaterThanOrEqual(3);
    });
  });
}
