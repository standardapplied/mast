import { describe, expect, test } from "bun:test";
import type { ThemeName } from "../shared/types";
import { createThemeController, type ThemeDeps } from "./theme";

function fakeDeps(overrides: { stored?: string; prefersDark?: boolean } = {}) {
  const store = new Map<string, string>();
  if (overrides.stored !== undefined) store.set("mast.theme", overrides.stored);
  let prefersDark = overrides.prefersDark ?? true;
  let prefersListener = () => {};
  const applied: ThemeName[] = [];
  const pushed: ThemeName[] = [];

  const deps: ThemeDeps = {
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
    prefersDark: () => prefersDark,
    onPrefersChange: (listener) => {
      prefersListener = listener;
    },
    apply: (theme) => void applied.push(theme),
    push: (theme) => void pushed.push(theme),
  };

  return {
    deps,
    store,
    applied,
    pushed,
    flipSystem: (dark: boolean) => {
      prefersDark = dark;
      prefersListener();
    },
  };
}

describe("theme controller", () => {
  test("first run follows the system preference", () => {
    const dark = fakeDeps({ prefersDark: true });
    expect(createThemeController(dark.deps).resolved()).toBe("dark");

    const light = fakeDeps({ prefersDark: false });
    expect(createThemeController(light.deps).resolved()).toBe("light");
    expect(light.applied).toEqual(["light"]);
    expect(light.pushed).toEqual(["light"]);
  });

  test("explicit mode persists and applies", () => {
    const f = fakeDeps({ prefersDark: true });
    const theme = createThemeController(f.deps);
    theme.setMode("light");
    expect(theme.mode()).toBe("light");
    expect(theme.resolved()).toBe("light");
    expect(f.store.get("mast.theme")).toBe("light");
    expect(f.applied).toEqual(["dark", "light"]);
    expect(f.pushed).toEqual(["dark", "light"]);
  });

  test("stored mode is restored; garbage falls back to system", () => {
    const stored = fakeDeps({ stored: "light", prefersDark: true });
    expect(createThemeController(stored.deps).resolved()).toBe("light");

    const garbage = fakeDeps({ stored: "solarized", prefersDark: true });
    const theme = createThemeController(garbage.deps);
    expect(theme.mode()).toBe("system");
    expect(theme.resolved()).toBe("dark");
  });

  test("system change re-themes only in system mode", () => {
    const f = fakeDeps({ prefersDark: true });
    const theme = createThemeController(f.deps);
    f.flipSystem(false);
    expect(theme.resolved()).toBe("light");

    theme.setMode("dark");
    f.flipSystem(true);
    f.flipSystem(false);
    expect(theme.resolved()).toBe("dark");
    expect(f.applied).toEqual(["dark", "light", "dark"]);
  });

  test("no duplicate apply/push when the resolved theme is unchanged", () => {
    const f = fakeDeps({ prefersDark: true });
    const theme = createThemeController(f.deps);
    theme.setMode("dark");
    theme.setMode("system");
    expect(f.applied).toEqual(["dark"]);
    expect(f.pushed).toEqual(["dark"]);
  });
});
