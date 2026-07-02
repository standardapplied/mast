import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { createDemoGateway, type DemoGateway } from "./gateway";
import { dispatchPush } from "./push";
import { browserThemeDeps, createThemeController } from "./theme";

let root: Root;
let container: HTMLElement;
let gateway: DemoGateway;

const flush = async () => {
  await act(async () => {});
};

beforeEach(() => {
  location.hash = "#/";
  localStorage.removeItem("mast.board.lanes");
});

async function render() {
  gateway = createDemoGateway();
  const theme = createThemeController(browserThemeDeps(() => {}));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App gateway={gateway} theme={theme} />));
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

  test("bridge state stays invisible until degraded", async () => {
    await render();
    expect(container.querySelector('[data-testid="bridge-status"]')).toBeNull();

    act(() => dispatchPush("bridge-status", { status: "reconnecting" }));
    expect(container.querySelector('[data-testid="bridge-status"]')?.textContent).toBe("Recovering…");

    act(() => dispatchPush("bridge-status", { status: "connected" }));
    expect(container.querySelector('[data-testid="bridge-status"]')).toBeNull();
  });

  test("the filter menu hides lanes via the multi-select, persists, guards the last lane", async () => {
    await render();
    expect(container.querySelectorAll(".kanban-column").length).toBe(5);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="filter-trigger"]')?.click();
    });
    expect(container.querySelector('[data-testid="filter-panel"]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="filter-panel"] .select-trigger')
        ?.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="option-done"]')?.click();
    });

    expect(container.querySelectorAll(".kanban-column").length).toBe(4);
    expect(container.querySelector('[data-testid="column-done"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem("mast.board.lanes")!)).not.toContain("done");
    expect(container.querySelector('[data-testid="filter-panel"]')).not.toBeNull();

    for (const lane of ["draft", "pending", "review"]) {
      act(() => {
        container.querySelector<HTMLButtonElement>(`[data-testid="option-${lane}"]`)?.click();
      });
    }
    expect(container.querySelectorAll(".kanban-column").length).toBe(1);
    const last = container.querySelector<HTMLButtonElement>('[data-testid="option-in_progress"]');
    expect(last?.disabled).toBe(true);
  });

  test("only-mine filter in the filter menu narrows the board", async () => {
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="filter-trigger"]')?.click();
    });
    const mine = container.querySelector<HTMLButtonElement>('[data-testid="filter-panel"] .switch');
    act(() => mine?.click());
    await flush();

    expect(container.querySelector('[data-testid="card-chorus-ledger-sync"]')).toBeNull();
    expect(container.querySelector('[data-testid="card-chorus-billing-export"]')).not.toBeNull();
  });

  test("user menu opens with the theme toggle and re-themes the document", async () => {
    localStorage.removeItem("mast.theme");
    await render();
    expect(container.querySelector('[data-testid="user-menu-panel"]')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="user-menu-trigger"]')?.click();
    });
    const panel = container.querySelector('[data-testid="user-menu-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("Not signed in");

    const dark = [...container.querySelectorAll<HTMLButtonElement>(".toggle-option")].find(
      (b) => b.textContent === "Dark",
    );
    act(() => dark?.click());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark?.getAttribute("aria-checked")).toBe("true");

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="user-menu-panel"]')).toBeNull();
  });
});
