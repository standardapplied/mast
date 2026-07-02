import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { createDemoGateway, type DemoGateway } from "./gateway";
import { dispatchPush } from "./push";

let root: Root;
let container: HTMLElement;
let gateway: DemoGateway;

const flush = async () => {
  await act(async () => {});
};

beforeEach(() => {
  location.hash = "#/";
});

async function render() {
  gateway = createDemoGateway();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App gateway={gateway} />));
  await flush();
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App cockpit", () => {
  test("renders the board with lifecycle columns and real cards", async () => {
    await render();
    expect(container.querySelector(".cockpit-brand")?.textContent).toBe("Mast");
    expect(container.querySelectorAll(".kanban-column").length).toBe(5);
    expect(container.querySelector('[data-testid="card-mast-kanban-board"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="column-done"]')?.textContent).toContain(
      "mast-api-client",
    );
  });

  test("shows a blocked card with its unmet dependencies", async () => {
    await render();
    const blocked = container.querySelector('[data-testid="card-chorus-ledger-sync"]');
    expect(blocked?.textContent).toContain("Blocked · chorus-billing-export");
  });

  test("board reflects a live SSE event without reload", async () => {
    await render();
    expect(container.querySelector('[data-testid="column-review"]')?.textContent).not.toContain(
      "chorus-invoice-ui",
    );

    await act(async () => {
      await gateway.updateSpec("chorus-invoice-ui", { status: "review" });
    });
    await flush();

    expect(container.querySelector('[data-testid="column-review"]')?.textContent).toContain(
      "chorus-invoice-ui",
    );
  });

  test("clicking a card routes to the spec detail with markdown, deps, and history", async () => {
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="card-chorus-ledger-sync"]')?.click();
    });
    await flush();
    await flush();

    expect(container.querySelector(".detail-title")?.textContent).toBe("chorus-ledger-sync");
    expect(container.querySelector('[data-testid="blocked-banner"]')?.textContent).toContain(
      "chorus-billing-export",
    );
    expect(container.querySelector(".markdown h1")?.textContent).toBe("Overview");
    expect(container.querySelectorAll(".history-row").length).toBe(3);
    expect(container.querySelector(".dep-chip.is-unmet")?.textContent).toBe("chorus-billing-export");
  });

  test("bridge badge reacts to bridge-status pushes", async () => {
    await render();
    act(() => dispatchPush("bridge-status", { status: "reconnecting" }));
    expect(
      container.querySelector('[data-testid="bridge-status"]')?.getAttribute("data-status"),
    ).toBe("reconnecting");
  });
});
