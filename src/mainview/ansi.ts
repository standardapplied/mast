import type { ThemeName } from "../shared/types";

/**
 * ANSI palettes for the terminal pillar (ghostty-web), drawn from the same
 * pigment family as the UI tokens: terracotta/oxide reds, sage/forest greens,
 * ochre yellows, dusty-steel/slate blues, madder magentas, verdigris cyans.
 *
 * ghostty renders SGR-dim as 50% alpha, which washes out on paper — so each
 * theme ships precomputed `dim` variants (blended toward the background) for
 * the adapter to substitute instead of alpha. Ref: dev-3.0 ansi-theme-adapt.
 */

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
  ansi: readonly string[];
  dim: readonly string[];
};

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16);
}

/** Blend `color` toward `background` — the dim substitute for alpha dimming. */
export function dimToward(color: string, background: string, amount = 0.45): string {
  const mix = (a: number, b: number) => Math.round(a * (1 - amount) + b * amount);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return (
    "#" +
    hex(mix(channel(color, 1), channel(background, 1))) +
    hex(mix(channel(color, 3), channel(background, 3))) +
    hex(mix(channel(color, 5), channel(background, 5)))
  );
}

function theme(spec: Omit<TerminalTheme, "dim">): TerminalTheme {
  return { ...spec, dim: spec.ansi.map((c) => dimToward(c, spec.background)) };
}

export const DARK_TERMINAL_THEME: TerminalTheme = theme({
  background: "#0a0e11",
  foreground: "#f6f1e9",
  cursor: "#fc4926",
  selectionBackground: "#f6f1e9",
  selectionForeground: "#0a0e11",
  ansi: [
    "#12171b", // black
    "#e07b6f", // red — terracotta
    "#86b89a", // green — sage
    "#d2a24c", // yellow — ochre
    "#93b3d7", // blue — dusty steel
    "#d08fa6", // magenta — madder rose
    "#7fbfca", // cyan — verdigris
    "#c9c4bc", // white — warm grey
    "#4a5560", // bright black
    "#f0968a", // bright red
    "#a3d1b3", // bright green
    "#e6ba69", // bright yellow
    "#aec8e8", // bright blue
    "#e3a8bc", // bright magenta
    "#9cd4de", // bright cyan
    "#f6f1e9", // bright white
  ],
});

export const LIGHT_TERMINAL_THEME: TerminalTheme = theme({
  background: "#f8fafc",
  foreground: "#0e1217",
  cursor: "#fc4926",
  selectionBackground: "#0e1217",
  selectionForeground: "#f8fafc",
  ansi: [
    "#0e1217", // black
    "#b42318", // red — oxide
    "#256e4a", // green — forest
    "#8a5800", // yellow — ochre ink
    "#31608f", // blue — slate
    "#9d4260", // magenta — madder
    "#17646f", // cyan — verdigris ink
    "#6d7277", // white — cool grey
    "#383e43", // bright black
    "#8f1c12", // bright red
    "#1d5a3c", // bright green
    "#6e4600", // bright yellow
    "#274d73", // bright blue
    "#7e344d", // bright magenta
    "#125058", // bright cyan
    "#0e1217", // bright white (ink on paper: bright = stronger, not lighter)
  ],
});

export function terminalTheme(name: ThemeName): TerminalTheme {
  return name === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}
