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
  localStorage.removeItem("mast.rooms.watermarks");
  localStorage.removeItem("mast.rooms.selections");
  localStorage.removeItem("mast.rooms.archive.open");
});

async function render(
  terminal?: React.ReactNode,
  initialView: "rooms" | "board" = "board",
) {
  gateway = createDemoGateway();
  const theme = createThemeController(browserThemeDeps(() => {}));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App gateway={gateway} theme={theme} terminal={terminal} />));
  await flush();
  if (initialView === "board") {
    await act(async () => navBtn("board")?.click());
    await flush();
  }
}

const navItems = () => [...container.querySelectorAll<HTMLButtonElement>(".rail-item")];
const navBtn = (view: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="nav-${view}"]`);
const activeNav = () =>
  container.querySelector(".rail-item.is-active")?.getAttribute("aria-label");

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App cockpit", () => {
  test("lands on rooms and keeps the board one view away", async () => {
    await render(undefined, "rooms");
    expect(container.querySelector(".rail-brand")).not.toBeNull();
    expect(activeNav()).toBe("Rooms");
    expect(container.querySelector('[data-testid="room-chorus-invoice-ui"]')).not.toBeNull();

    await act(async () => navBtn("board")?.click());
    expect(container.querySelectorAll(".kanban-column").length).toBe(7);
    expect(container.querySelector('[data-testid="card-mast-kanban-board"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="column-done"]')?.textContent).toContain(
      "mast-api-client",
    );
  });

  test("Rooms/Board nav remains reachable when no terminal is injected", async () => {
    await render(undefined, "rooms");
    const labels = navItems().map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Rooms", "Board"]);
  });

  test("Rooms/Board/Terminal nav switches views and keeps the terminal mounted", async () => {
    await render(<div data-testid="term-stub">TERM</div>, "rooms");

    expect(navItems().map((i) => i.getAttribute("aria-label"))).toEqual([
      "Rooms",
      "Board",
      "Terminal",
    ]);
    expect(activeNav()).toBe("Rooms");
    expect(container.querySelector('[data-testid="term-stub"]')).toBeNull();

    await act(async () => navBtn("terminal")!.click());
    const stub = container.querySelector('[data-testid="term-stub"]');
    expect(stub).not.toBeNull();
    expect((stub!.closest(".cockpit-view") as HTMLElement).style.display).toBe("flex");
    expect(activeNav()).toBe("Terminal");

    // Back to the board: the terminal stays mounted (session preserved), just hidden.
    await act(async () => navBtn("board")!.click());
    const stillThere = container.querySelector('[data-testid="term-stub"]');
    expect(stillThere).not.toBeNull();
    expect((stillThere!.closest(".cockpit-view") as HTMLElement).style.display).toBe("none");
    expect(activeNav()).toBe("Board");
  });

  test("leaving a view and returning never cold-boots it", async () => {
    await render(<div data-testid="term-stub">TERM</div>, "rooms");
    const originalListSpecs = gateway.listSpecs.bind(gateway);
    let refetches = 0;
    gateway.listSpecs = (filter) => {
      refetches++;
      return originalListSpecs(filter);
    };
    const roomsView = () => container.querySelector('[data-testid="view-rooms"]') as HTMLElement;
    expect(roomsView().querySelector(".rooms-sidebar")).not.toBeNull();

    await act(async () => navBtn("terminal")!.click());
    await flush();
    expect(roomsView().style.display).toBe("none");
    expect(roomsView().querySelector(".rooms-sidebar")).not.toBeNull();

    await act(async () => navBtn("rooms")!.click());
    await flush();
    expect(roomsView().style.display).toBe("flex");
    expect(roomsView().querySelector(".rooms-sidebar")).not.toBeNull();
    expect(refetches).toBe(0);
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

  test("pointer drag lifts the card and marks the board; releasing clears both", async () => {
    await render();
    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-billing-export"]');
    const board = container.querySelector(".board");

    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });

    act(() => card?.dispatchEvent(pointer("pointerdown", 10, 10)));
    // move past the 6px threshold to activate the drag
    act(() => window.dispatchEvent(pointer("pointermove", 100, 100)));
    expect(board?.classList.contains("is-dragging")).toBe(true);
    expect(card?.classList.contains("is-lifted")).toBe(true);

    act(() => window.dispatchEvent(pointer("pointerup", 100, 100)));
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

    const board = container.querySelector('[data-testid="view-board"]')!;
    expect(board.querySelector(".detail-title")?.textContent).toBe("Ledger sync worker");
    expect(board.querySelector('[data-testid="blocked-banner"]')?.textContent).toContain(
      "chorus-billing-export",
    );
    expect(board.querySelector(".markdown h1")?.textContent).toBe("Overview");
    expect(board.querySelectorAll(".history-row").length).toBe(3);
    expect(board.querySelector(".dep-chip.is-unmet")?.textContent).toBe("chorus-billing-export");
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
        (b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch…",
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

  test("context menu offers a live/review log entry only for active specs", async () => {
    await render();
    const rightClick = (id: string) => {
      act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      container.querySelector<HTMLElement>(`[data-testid="card-${id}"]`)?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
      );
    };
    const labels = () =>
      [...container.querySelectorAll(".context-menu-label")].map((n) => n.textContent);

    act(() => rightClick("chorus-invoice-ui")); // in_progress
    expect(labels()).toContain("Live log");

    act(() => rightClick("chorus-rate-limits")); // review
    expect(labels()).toContain("Review log");

    act(() => rightClick("chorus-billing-export")); // pending → neither
    expect(labels()).not.toContain("Live log");
    expect(labels()).not.toContain("Review log");
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
    expect(container.querySelector(".detail-title")?.textContent).toBe("Passkey auth flow");
  });

  test("context menu offers Re-dispatch only for review and done specs", async () => {
    await render();
    const rightClick = (id: string) => {
      act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      container.querySelector<HTMLElement>(`[data-testid="card-${id}"]`)?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
      );
    };
    const labels = () =>
      [...container.querySelectorAll(".context-menu-label")].map((n) => n.textContent);

    act(() => rightClick("chorus-rate-limits")); // review
    expect(labels()).toContain("Re-dispatch…");

    act(() => rightClick("chorus-onboarding")); // done
    expect(labels()).toContain("Re-dispatch…");

    act(() => rightClick("chorus-billing-export")); // pending
    expect(labels()).not.toContain("Re-dispatch…");

    act(() => rightClick("chorus-invoice-ui")); // in_progress
    expect(labels()).not.toContain("Re-dispatch…");
  });

  test("re-dispatch relaunches a review spec into in progress", async () => {
    await render();
    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-rate-limits"]');
    act(() => {
      card?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }),
      );
    });
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")]
        .find((b) => b.querySelector(".context-menu-label")?.textContent === "Re-dispatch…")
        ?.click();
    });
    await flush();

    expect(container.querySelector(".dialog-title")?.textContent).toBe(
      "Re-dispatch chorus-rate-limits",
    );
    expect(container.textContent).toContain(
      "Re-dispatch resets chorus-rate-limits to pending and relaunches on its prior branch.",
    );
    const go = container.querySelector<HTMLButtonElement>('[data-testid="dispatch-go"]');
    expect(go?.disabled).toBe(false);

    act(() => go?.click());
    await flush();
    await flush();
    expect(container.querySelector('[data-testid="column-in_progress"]')?.textContent).toContain(
      "chorus-rate-limits",
    );
    expect(container.textContent).toContain("Re-dispatched chorus-rate-limits (was review).");
  });

  const renderAs = async (role: "member" | "viewer", capabilities: string[]) => {
    gateway = createDemoGateway();
    gateway.whoami = () =>
      Promise.resolve({
        ok: true,
        value: { fde: "ravi", name: "ravi", role, capabilities },
      });
    const theme = createThemeController(browserThemeDeps(() => {}));
    location.hash = "#/";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<App gateway={gateway} theme={theme} />));
    await flush();
    await flush();
    await act(async () => navBtn("board")?.click());
    await flush();

    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-billing-export"]');
    act(() => {
      card?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }),
      );
    });
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")]
        .find((b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch…")
        ?.click();
    });
    await flush();
  };

  test("a member (write credential) can dispatch — the server's policy is the authority", async () => {
    await renderAs("member", ["read", "write"]);
    expect(container.querySelector('[data-testid="dispatch-role"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="dispatch-go"]')?.disabled).toBe(false);
  });

  test("dispatch dialog gates a read-only credential", async () => {
    await renderAs("viewer", ["read"]);
    expect(container.querySelector('[data-testid="dispatch-role"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="dispatch-go"]')?.disabled).toBe(true);
  });

  test("dispatch dialog: dispatch moves the spec to in progress", async () => {
    await render();
    const card = container.querySelector<HTMLElement>('[data-testid="card-chorus-billing-export"]');
    act(() => {
      card?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }),
      );
    });
    const menuDispatch = [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
      (b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch…",
    );
    act(() => menuDispatch?.click());
    await flush();

    // The dialog opens with the spec's facts and an enabled Dispatch button.
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Dispatch chorus-billing-export");
    const go = container.querySelector<HTMLButtonElement>('[data-testid="dispatch-go"]');
    expect(go?.disabled).toBe(false);

    act(() => go?.click());
    await flush();
    await flush();
    expect(container.querySelector('[data-testid="column-in_progress"]')?.textContent).toContain(
      "chorus-billing-export",
    );
  });

  test("the filter menu hides lanes via the multi-select, persists, guards the last lane", async () => {
    await render();
    expect(container.querySelectorAll(".kanban-column").length).toBe(7);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="filter-trigger"]')?.click();
    });
    expect(document.querySelector('[data-testid="filter-panel"]')).not.toBeNull();

    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="filter-lanes"] .select-trigger')
        ?.click();
    });
    const laneOption = (lane: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid="option-${lane}"]`);
    expect(laneOption("done")?.querySelector(".checkbox.is-checked")).not.toBeNull();

    act(() => laneOption("done")?.click());
    expect(container.querySelectorAll(".kanban-column").length).toBe(6);
    expect(container.querySelector('[data-testid="column-done"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem("mast.board.lanes")!)).not.toContain("done");
    expect(document.querySelector('[data-testid="filter-panel"]')).not.toBeNull();

    for (const lane of ["draft", "pending", "review", "awaiting_merge", "cancelled"]) {
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
      document
        .querySelector<HTMLButtonElement>('[data-testid="filter-repo"] .select-trigger')
        ?.click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="option-api"]')?.click();
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
    const mine = document.querySelector<HTMLButtonElement>('[data-testid="filter-mine"] .checkbox');
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
    expect(panel?.textContent).toContain("Uday K");
    expect(panel?.textContent).toContain("uday@singlr.ai");

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
