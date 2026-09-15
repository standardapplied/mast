import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { attentionStore } from "../terminal/attention";
import { browserThemeDeps, createThemeController } from "../theme";
import { UserMenu } from "./UserMenu";

let root: Root;
let container: HTMLElement;

const mousedown = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });

beforeEach(() => {
  localStorage.clear();
  attentionStore.reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<UserMenu theme={createThemeController(browserThemeDeps(() => {}))} />));
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="user-menu-trigger"]')!.click());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("UserMenu", () => {
  test("the shell bell is a Select: picking a choice keeps the menu open and sets the bell", () => {
    const section = container.querySelector('[data-testid="terminal-bell"]')!;
    expect(section.querySelector(".eyebrow")?.textContent).toBe("Shell bell");
    const trigger = section.querySelector<HTMLButtonElement>(".select-trigger")!;
    expect(trigger.textContent).toContain("Sound + bounce");

    act(() => trigger.click());
    const option = document.querySelector<HTMLButtonElement>('[data-testid="option-flash"]')!;
    mousedown(option);
    expect(container.querySelector('[data-testid="user-menu-panel"]'), "the menu survived the pick").not.toBeNull();
    act(() => option.click());
    expect(attentionStore.bell()).toBe("flash");
    expect(trigger.textContent).toContain("Flash");
    expect(document.querySelector(".dropdown-panel")).toBeNull();
  });

  test("a mousedown outside the menu still closes it", () => {
    mousedown(document.body);
    expect(container.querySelector('[data-testid="user-menu-panel"]')).toBeNull();
  });
});
