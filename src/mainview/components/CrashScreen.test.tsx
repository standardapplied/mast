import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { CrashScreen, resetTerminalLayouts } from "./CrashScreen";
import { recentErrors } from "../errorLog";

function Boom(): never {
  throw new Error("kaboom at render");
}

describe("CrashScreen", () => {
  test("renders its children when nothing throws", () => {
    const html = renderToString(
      <CrashScreen>
        <span>fine</span>
      </CrashScreen>,
    );
    expect(html).toContain("fine");
    expect(html).not.toContain("crash-screen");
  });

  test("getDerivedStateFromError puts the error on screen with both recoveries", () => {
    const state = CrashScreen.getDerivedStateFromError(new Error("kaboom at render"));
    const screen = new CrashScreen({ children: <Boom /> });
    screen.state = state;
    const html = renderToString(screen.render() as never);
    expect(html).toContain("kaboom at render");
    expect(html).toContain("Reload");
    expect(html).toContain("Reset terminal layouts and reload");
  });

  test("componentDidCatch reports the message, stack, and component stack", () => {
    const reported: string[] = [];
    const screen = new CrashScreen({ children: null, report: (m) => reported.push(m) });
    screen.componentDidCatch(new Error("kaboom at render"), { componentStack: "\n    at Boom" });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("kaboom at render");
    expect(reported[0]).toContain("at Boom");
    expect(recentErrors().some((e) => e.source === "render" && e.message.includes("kaboom"))).toBe(
      true,
    );
  });

  test("resetTerminalLayouts forgets only the stored pane arrangements", () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => Object.assign(Object.fromEntries(store), fake),
    });
    store.set("mast.panes.mast-sail", "{}");
    store.set("mast.panes.room:r1", "{}");
    store.set("mast.theme", "dark");
    resetTerminalLayouts();
    expect([...store.keys()]).toEqual(["mast.theme"]);
  });
});
