import type { ThemeName } from "../shared/types";

export type ThemeMode = ThemeName | "system";

export type ThemeController = {
  mode: () => ThemeMode;
  resolved: () => ThemeName;
  setMode: (mode: ThemeMode) => void;
};

/**
 * Side effects are injected so the resolution logic (persistence, system
 * preference, change propagation) is unit-testable without a real DOM.
 * `push` mirrors every resolved change to the Bun side so the terminal pillar
 * can re-theme tmux/ghostty in lockstep with the UI.
 */
export type ThemeDeps = {
  storage: Pick<Storage, "getItem" | "setItem">;
  prefersDark: () => boolean;
  onPrefersChange: (listener: () => void) => void;
  apply: (theme: ThemeName) => void;
  push: (theme: ThemeName) => void;
};

const STORAGE_KEY = "mast.theme";

function isMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function createThemeController(deps: ThemeDeps): ThemeController {
  const stored = deps.storage.getItem(STORAGE_KEY);
  let mode: ThemeMode = isMode(stored) ? stored : "system";
  let active: ThemeName | undefined;

  const resolve = (): ThemeName =>
    mode === "system" ? (deps.prefersDark() ? "dark" : "light") : mode;

  const sync = () => {
    const next = resolve();
    if (next === active) return;
    active = next;
    deps.apply(next);
    deps.push(next);
  };

  deps.onPrefersChange(() => {
    if (mode === "system") sync();
  });
  sync();

  return {
    mode: () => mode,
    resolved: () => active as ThemeName,
    setMode: (next) => {
      mode = next;
      deps.storage.setItem(STORAGE_KEY, next);
      sync();
    },
  };
}

export function browserThemeDeps(push: (theme: ThemeName) => void): ThemeDeps {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    storage: window.localStorage,
    prefersDark: () => media.matches,
    onPrefersChange: (listener) => media.addEventListener("change", listener),
    apply: (theme) => {
      document.documentElement.dataset.theme = theme;
    },
    push,
  };
}
