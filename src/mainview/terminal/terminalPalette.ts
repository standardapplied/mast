/**
 * Resolves Mast's paper/ink terminal theme into the RGB triples the VT core and WebGPU renderer
 * consume. Transport-free and DOM-light so it stays unit-testable: the React hook that watches for
 * theme changes lives in the pane, but the resolution itself is here.
 */

import type { ThemeName } from "../../shared/types";
import { terminalTheme } from "../ansi";
import type { Rgb } from "./vtCore";

/** Mast's resolved terminal theme, as the colors the core and renderer paint with. */
export interface Palette {
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly cursor: Rgb;
}

/** Parses a `#rrggbb` string into an {@link Rgb} triple. */
export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The theme's foreground, background, and cursor as RGB. */
export function paletteFor(name: ThemeName): Palette {
  const t = terminalTheme(name);
  return { fg: hexToRgb(t.foreground), bg: hexToRgb(t.background), cursor: hexToRgb(t.cursor) };
}

/** The active theme from the document's `data-theme`, falling back to the OS color-scheme. */
export function resolveThemeName(): ThemeName {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "light" || stamped === "dark") return stamped;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
