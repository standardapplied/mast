import type { ThemeName } from "../shared/types";

/**
 * The active UI theme as last reported by the webview (`setTheme`). The
 * terminal pillar reads this to theme tmux/ghostty in lockstep with the UI.
 */
let active: ThemeName = "dark";

export function setActiveTheme(theme: ThemeName): void {
  active = theme;
}

export function activeTheme(): ThemeName {
  return active;
}
