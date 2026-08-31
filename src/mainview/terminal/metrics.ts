/**
 * The one set of terminal font metrics. Every terminal surface — the Terminal
 * workspace's panes and the room's full-bleed stage — renders through
 * SessionTerminalPane, which must source these constants from here and nowhere
 * else: the 0.1.70 "dots below characters" field bug taught that a stage whose
 * geometry disagrees with the Terminal view produces off-metric cells and dirty
 * atlas sampling. metrics.test.ts pins the values and the single source.
 *
 * If glyph artifacts recur, A/B the SAME session in the Terminal view and the room
 * stage: identical artifacts point at the VT/style bits or the atlas (undercurl
 * SGR 4:x decode first), room-only artifacts point at stage geometry (fractional
 * metrics / devicePixelRatio).
 */

export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", monospace';
export const TERMINAL_FONT_PX = 15;
export const TERMINAL_LINE_PAD = 0.25;
/** Ghostty-style window padding: breathing room between the pane edge and the first glyph. */
export const TERMINAL_PAD_X = 10;
export const TERMINAL_PAD_Y = 8;
