import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { dispatchPush } from "./push";

let root: Root;
let container: HTMLElement;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App shell", () => {
  test("renders the empty themed shell", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe("Mast");
    expect(container.querySelector('[data-testid="bridge-status"]')?.getAttribute("data-status")).toBe(
      "connected",
    );
  });

  test("reacts to a bridge-status push message", () => {
    render();
    const status = () => container.querySelector('[data-testid="bridge-status"]');
    act(() => dispatchPush("bridge-status", { status: "reconnecting" }));
    expect(status()?.getAttribute("data-status")).toBe("reconnecting");
    expect(status()?.textContent).toBe("Reconnecting…");
  });
});
