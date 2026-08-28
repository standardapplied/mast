/**
 * Resolves Mast's paper/ink terminal theme into the RGB triples the VT core and WebGPU renderer
 * consume. Transport-free and DOM-light so it stays unit-testable: the React hook that watches for
 * theme changes lives in the pane, but the resolution itself is here.
 */

import type { ThemeName } from "../../shared/types";
import { terminalTheme } from "../ansi";
import type { Rgb, Theme } from "./vtCore";

/** Parses a `#rrggbb` string into an {@link Rgb} triple. */
export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A {@link Theme} for the VT core, plus the selection-highlight colors the renderer needs. */
export interface TerminalColors extends Theme {
  readonly selectionBg: Rgb;
  readonly selectionFg: Rgb;
}

/** Mast's resolved terminal theme as the colors the VT core and renderer consume. */
export function paletteFor(name: ThemeName): TerminalColors {
  const t = terminalTheme(name);
  return {
    fg: hexToRgb(t.foreground),
    bg: hexToRgb(t.background),
    cursor: hexToRgb(t.cursor),
    palette: t.ansi.map(hexToRgb),
    selectionBg: hexToRgb(t.selectionBackground),
    selectionFg: hexToRgb(t.selectionForeground),
  };
}

/** The active theme from the document's `data-theme`, falling back to the OS color-scheme. */
export function resolveThemeName(): ThemeName {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "light" || stamped === "dark") return stamped;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
