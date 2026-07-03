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
    expect(container.querySelectorAll(".kanban-column").length).toBe(6);
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

  test("dragging lifts the card and marks the board; a cancelled drag clears both", async () => {
    await render();
    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-billing-export"]');
    const board = container.querySelector(".board");

    const dt = new DataTransfer();
    act(() => {
      const e = new Event("dragstart", { bubbles: true }) as DragEvent;
      Object.defineProperty(e, "dataTransfer", { value: dt });
      card?.dispatchEvent(e);
    });
    expect(board?.classList.contains("is-dragging")).toBe(true);
    expect(card?.classList.contains("is-lifted")).toBe(true);

    act(() => {
      const e = new Event("dragend", { bubbles: true }) as DragEvent;
      Object.defineProperty(e, "dataTransfer", { value: dt });
      card?.dispatchEvent(e);
    });
    expect(board?.classList.contains("is-dragging")).toBe(false);
    expect(card?.classList.contains("is-lifted")).toBe(false);
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

  test("a bridge timeout in spec detail shows 'lost contact', not the raw RPC error", async () => {
    gateway = createDemoGateway();
    gateway.getSpec = () =>
      Promise.resolve({ ok: false, error: { status: 0, code: "bridge", message: "Error: RPC request timed out." } });
    const theme = createThemeController(browserThemeDeps(() => {}));
    location.hash = "#/spec/chorus-invoice-ui";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<App gateway={gateway} theme={theme} />));
    await flush();
    await flush();

    const text = container.querySelector(".detail")?.textContent ?? "";
    expect(text).toContain("Lost contact with the control plane");
    expect(text).not.toContain("RPC request timed out");
  });

  test("right-click opens a context menu; Dispatch enabled only for a ready pending spec", async () => {
    await render();
    const rightClick = (id: string) => {
      const card = container.querySelector<HTMLElement>(`[data-testid="card-${id}"]`);
      act(() => {
        card?.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
        );
      });
    };
    const dispatchItem = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
        (b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch",
      );

    // Pending + assigned + no unmet deps → dispatchable.
    rightClick("chorus-billing-export");
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull();
    expect(dispatchItem()?.disabled).toBe(false);

    // Pending but blocked by an unmet dependency → disabled.
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    rightClick("chorus-ledger-sync");
    expect(dispatchItem()?.disabled).toBe(true);

    // In-progress spec → not dispatchable.
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    rightClick("chorus-invoice-ui");
    expect(dispatchItem()?.disabled).toBe(true);
  });

  test("context menu View routes to the spec detail", async () => {
    await render();
    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-auth-flow"]');
    act(() => {
      card?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
      );
    });
    const view = [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
      (b) => b.querySelector(".context-menu-label")?.textContent === "View",
    );
    act(() => view?.click());
    await flush();
    expect(container.querySelector(".detail-title")?.textContent).toBe("chorus-auth-flow");
  });

  test("dispatching a ready spec moves it to in progress", async () => {
    await render();
    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-billing-export"]');
    act(() => {
      card?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }),
      );
    });
    const dispatch = [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
      (b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch",
    );
    act(() => dispatch?.click());
    await flush();
    await flush();
    expect(container.querySelector('[data-testid="column-in_progress"]')?.textContent).toContain(
      "chorus-billing-export",
    );
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
    expect(container.querySelectorAll(".kanban-column").length).toBe(6);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="filter-trigger"]')?.click();
    });
    expect(container.querySelector('[data-testid="filter-panel"]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="filter-lanes"] .select-trigger')
        ?.click();
    });
    const laneOption = (lane: string) =>
      container.querySelector<HTMLButtonElement>(`[data-testid="option-${lane}"]`);
    expect(laneOption("done")?.querySelector(".checkbox.is-checked")).not.toBeNull();

    act(() => laneOption("done")?.click());
    expect(container.querySelectorAll(".kanban-column").length).toBe(5);
    expect(container.querySelector('[data-testid="column-done"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem("mast.board.lanes")!)).not.toContain("done");
    expect(container.querySelector('[data-testid="filter-panel"]')).not.toBeNull();

    for (const lane of ["draft", "pending", "review", "awaiting_merge"]) {
      act(() => laneOption(lane)?.click());
    }
    expect(container.querySelectorAll(".kanban-column").length).toBe(1);
    expect(laneOption("in_progress")?.disabled).toBe(true);
  });

  test("repo filter narrows the board to specs touching that repo", async () => {
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="filter-trigger"]')?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="filter-repo"] .select-trigger')
        ?.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="option-api"]')?.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="card-chorus-billing-export"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="card-chorus-invoice-ui"]')).toBeNull();
  });

  test("only-mine filter in the filter menu narrows the board", async () => {
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="filter-trigger"]')?.click();
    });
    const mine = container.querySelector<HTMLButtonElement>('[data-testid="filter-mine"] .checkbox');
    act(() => mine?.click());
    await flush();

    expect(container.querySelector('[data-testid="card-chorus-ledger-sync"]')).toBeNull();
    expect(container.querySelector('[data-testid="card-chorus-billing-export"]')).not.toBeNull();
  });

  test("unauthenticated status shows the connect screen and login flows through", async () => {
    gateway = createDemoGateway();
    const logins: string[] = [];
    const signedOut = {
      phase: "unauthenticated" as const,
      server: "http://127.0.0.1:7070",
      loginOrigin: "http://localhost:7070",
      tokenPresent: true,
      stream: "disconnected" as const,
      detail: "Session expired or token invalid — sign in again.",
    };
    const authGateway = {
      ...gateway,
      connection: async () => signedOut,
      onConnectionStatus: (l: (s: typeof signedOut) => void) => {
        l(signedOut);
        return () => {};
      },
      login: async () => {
        logins.push("ceremony");
        return { ok: true };
      },
    };
    const theme = createThemeController(browserThemeDeps(() => {}));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<App gateway={authGateway as never} theme={theme} />));
    await flush();

    expect(container.querySelector('[data-testid="connect-screen"]')).not.toBeNull();
    expect(container.textContent).toContain("Sign in to Sail");

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="connect-login"]')?.click();
    });
    await flush();
    expect(logins).toEqual(["ceremony"]);
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
    expect(panel?.textContent).toContain("Passkey session");

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
