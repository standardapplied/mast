import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Styleguide } from "./styleguide";
import type { ThemeController, ThemeMode } from "./theme";

let root: Root;
let container: HTMLElement;

function fakeTheme(): ThemeController & { setMode: ReturnType<typeof mock> } {
  return {
    mode: () => "system" as ThemeMode,
    resolved: () => "dark" as const,
    setMode: mock(() => {}),
  };
}

function render(theme: ThemeController) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Styleguide theme={theme} />));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Styleguide", () => {
  test("renders every token swatch and the component sections", () => {
    render(fakeTheme());
    expect(container.querySelectorAll("code").length).toBeGreaterThanOrEqual(15);
    expect(container.querySelector("h1")?.textContent).toBe("Mast styleguide");
    expect(container.querySelectorAll("h2").length).toBe(16);
    expect(container.querySelector(".room-avatar.is-agent")).not.toBeNull();
    expect(container.querySelector(".room-header")).not.toBeNull();
    expect(container.querySelector(".room-details-drawer")).not.toBeNull();
  });

  test("theme buttons drive the controller", () => {
    const theme = fakeTheme();
    render(theme);
    const light = container.querySelector<HTMLButtonElement>('[data-testid="theme-light"]');
    act(() => light?.click());
    expect(theme.setMode).toHaveBeenCalledWith("light");
    expect(light?.getAttribute("aria-selected")).toBe("true");
  });
});
