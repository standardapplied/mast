import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectCodeCheck, ConnectionStatus } from "../shared/sail-models";
import { App } from "./App";
import { catalogStore } from "./board/catalogStore";
import { FORGOTTEN_NOTICE } from "./components/ConnectScreen";
import { createDemoGateway, type DemoGateway } from "./gateway";
import { dispatchPush } from "./push";
import { attentionStore } from "./terminal/attention";
import { clipboardPolicy } from "./terminal/clipboardPolicy";
import { scrollbackBudget } from "./terminal/scrollbackBudget";
import { sessionStore } from "./terminal/sessionStore";
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
  sessionStore.reset();
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
  act(() =>
    root.render(
      <App gateway={gateway} theme={theme} terminal={terminal ? () => terminal : undefined} />,
    ),
  );
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
  test("the topbar and connected node row show the same stored sync health", async () => {
    await render();
    gateway.syncStatus = async () => ({ ok: true, value: {
      role: "node", main: "main", state: "stale", consecutive_failures: 5,
      last_attempt_at: new Date().toISOString(), last_error_kind: "protocol",
      last_error: "message: page exceeded 4 MiB",
      stale_since: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    } });
    await act(async () => gateway.emit({
      v: 1, ts: new Date().toISOString(), project: "sail", type: "sync_degraded",
      agent: "sail", host: "node",
    }));
    expect(container.querySelector(".topbar [data-sync-state]")?.textContent)
      .toBe("stale since 3 d — message: page exceeded 4 MiB");
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="user-menu-trigger"]')?.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Diagnostics")?.click());
    expect(document.querySelector(".sync-node-row")?.textContent).toContain("demo fixtures");
    expect(document.querySelector(".sync-node-row [data-sync-state]")?.textContent)
      .toBe("stale since 3 d — message: page exceeded 4 MiB");
  });

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

  test("the top chrome band is context-aware: label per view, tab slot only in the terminal", async () => {
    await render(<div data-testid="fake-terminal" />, "rooms");
    const slot = () => container.querySelector<HTMLElement>("#topbar-slot")!;
    const label = () => container.querySelector(".topbar__context")?.textContent ?? null;

    expect(container.querySelector(".topbar")).not.toBeNull();
    expect(label()).toBe("Rooms");
    expect(slot().style.display).toBe("none");

    await act(async () => navBtn("board")?.click());
    expect(label()).toBe("Board");

    await act(async () => navBtn("terminal")?.click());
    await flush();
    expect(label()).toBeNull(); // the terminal owns the band through the slot
    expect(slot().style.display).not.toBe("none");

    await act(async () => navBtn("rooms")?.click());
    expect(label()).toBe("Rooms");
    expect(slot().style.display).toBe("none"); // the strip stays mounted, just hidden
  });

  test("the top band is a deep drag region so its empty pixels move the window", async () => {
    await render(undefined, "rooms");
    expect(container.querySelector(".topbar")?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(container.querySelector(".rail")?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  test("the injected terminal is told whether its view is on screen", async () => {
    gateway = createDemoGateway();
    const theme = createThemeController(browserThemeDeps(() => {}));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <App
          gateway={gateway}
          theme={theme}
          terminal={(_open, active) => (
            <div data-testid="fake-terminal" data-active={String(active)} />
          )}
        />,
      ),
    );
    await flush();
    const fake = () => container.querySelector('[data-testid="fake-terminal"]');
    await act(async () => navBtn("terminal")!.click());
    await flush();
    expect(fake()?.getAttribute("data-active")).toBe("true");
    await act(async () => navBtn("board")!.click());
    await flush();
    expect(fake(), "hidden, still mounted").not.toBeNull();
    expect(fake()?.getAttribute("data-active"), "a hidden workspace holds no active pane").toBe(
      "false",
    );
    await act(async () => navBtn("terminal")!.click());
    await flush();
    expect(fake()?.getAttribute("data-active")).toBe("true");
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

  test("a deck card opens the full-screen terminal route; back lands on the spec detail untouched", async () => {
    await render();
    gateway.listSessions = async () => ({
      ok: true,
      value: {
        hostBootId: "boot-1",
        sessions: [
        {
          name: "room-chorus-invoice-ui",
          instanceId: "inst-room-chorus-invoice-ui",
          live: true,
          attached: 1,
          writerFde: "uday",
          room: "chorus-invoice-ui",
          command: ["claude"],
        },
        ],
      },
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="card-chorus-invoice-ui"]')?.click();
    });
    await flush();
    await flush();

    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid="deck-card-room-chorus-invoice-ui"]',
    );
    expect(card, "the room's sessions surface as header cards").not.toBeNull();
    await act(async () => card?.click());
    await flush();

    const route = container.querySelector('[data-testid="view-room-terminal"]');
    expect(route).not.toBeNull();
    expect(
      container.querySelector("#topbar-route-slot")?.textContent,
      "the route's title lives in the chrome band, once",
    ).toContain("Invoice review UI");
    expect(
      route?.querySelector('[data-testid="deck-attach-unavailable"]'),
      "without the Tauri edge the route explains itself",
    ).not.toBeNull();
    const board = container.querySelector('[data-testid="view-board"]') as HTMLElement;
    expect(board.style.display).toBe("none");
    expect(board.querySelector(".detail"), "the spec detail stays mounted underneath").not.toBeNull();
    const routeSlot = container.querySelector<HTMLElement>("#topbar-route-slot");
    expect(routeSlot?.style.display).toBe("flex");
    expect(
      routeSlot?.querySelector('[data-testid="route-back"]'),
      "the route bar rides the chrome band, not a second bar",
    ).not.toBeNull();
    expect(container.querySelector(".topbar__context"), "no duplicate title label").toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="route-back"]')?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="view-room-terminal"]')).toBeNull();
    expect(board.style.display).toBe("flex");
    expect(board.querySelector(".detail-title")?.textContent).toBe("Invoice review UI");
  });

  test("rail navigation while the route is open leaves it — no stacked surfaces", async () => {
    await render(<div data-testid="term-stub">TERM</div>);
    gateway.listSessions = async () => ({
      ok: true,
      value: {
        hostBootId: "boot-1",
        sessions: [
        {
          name: "room-chorus-invoice-ui",
          instanceId: "inst-room-chorus-invoice-ui",
          live: true,
          attached: 1,
          writerFde: "uday",
          room: "chorus-invoice-ui",
          command: ["claude"],
        },
        ],
      },
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="card-chorus-invoice-ui"]')?.click();
    });
    await flush();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-card-room-chorus-invoice-ui"]')
        ?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="view-room-terminal"]')).not.toBeNull();

    await act(async () => navBtn("terminal")!.click());
    await flush();
    expect(container.querySelector('[data-testid="view-room-terminal"]')).toBeNull();
    expect(activeNav()).toBe("Terminal");
  });

  test("losing authentication tears down the room route, and re-login does not restore it", async () => {
    type Status = Awaited<ReturnType<DemoGateway["connection"]>>;
    gateway = createDemoGateway();
    gateway.listSessions = async () => ({
      ok: true,
      value: {
        hostBootId: "boot-1",
        sessions: [
        {
          name: "room-chorus-invoice-ui",
          instanceId: "inst-room-chorus-invoice-ui",
          live: true,
          attached: 1,
          writerFde: "uday",
          room: "chorus-invoice-ui",
          command: ["claude"],
        },
        ],
      },
    });
    const listeners = new Set<(s: Status) => void>();
    const base = await gateway.connection();
    const push = async (phase: Status["phase"]) => {
      await act(async () => {
        for (const l of listeners) l({ ...base, phase });
      });
      await flush();
    };
    const authGateway = {
      ...gateway,
      onConnectionStatus: (l: (s: Status) => void) => {
        listeners.add(l);
        l(base);
        return () => listeners.delete(l);
      },
    };
    const theme = createThemeController(browserThemeDeps(() => {}));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<App gateway={authGateway as never} theme={theme} />));
    await flush();
    await act(async () => navBtn("board")?.click());
    await flush();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="card-chorus-invoice-ui"]')?.click();
    });
    await flush();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-card-room-chorus-invoice-ui"]')
        ?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="view-room-terminal"]')).not.toBeNull();

    // Logout (or token expiry) must unmount the interactive PTY surface with
    // everything else — the gate owns the whole window — and must clear the
    // catalog: rooms, specs, runs, and the FDE identity belong to the account
    // that signed out, and the next sign-in may be someone else.
    expect(catalogStore.specList().length).toBeGreaterThan(0);
    await push("unauthenticated");
    expect(container.querySelector('[data-testid="view-room-terminal"]')).toBeNull();
    expect(container.querySelector('[data-testid="connect-screen"]')).not.toBeNull();
    expect(catalogStore.specList()).toEqual([]);
    expect(catalogStore.roomList()).toBeNull();
    expect(catalogStore.me).toBeUndefined();

    await push("ready");
    expect(container.querySelector('[data-testid="connect-screen"]')).toBeNull();
    expect(container.querySelector('[data-testid="view-room-terminal"]')).toBeNull();
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
    expect(labels()).toContain("Re-dispatch");

    act(() => rightClick("chorus-onboarding")); // done
    expect(labels()).toContain("Re-dispatch");

    act(() => rightClick("chorus-billing-export")); // pending
    expect(labels()).not.toContain("Re-dispatch");

    act(() => rightClick("chorus-invoice-ui")); // in_progress
    expect(labels()).not.toContain("Re-dispatch");
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
        .find((b) => b.querySelector(".context-menu-label")?.textContent === "Re-dispatch")
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
        .find((b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch")
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
      (b) => b.querySelector(".context-menu-label")?.textContent === "Dispatch",
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

  test("the user menu's shell clipboard toggle is the stored setting", async () => {
    localStorage.setItem("mast.terminal.clipboard-write", "deny");
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="user-menu-trigger"]')?.click();
    });
    const section = container.querySelector('[data-testid="clipboard-write"]');
    const option = (label: string) =>
      [...section!.querySelectorAll<HTMLButtonElement>(".toggle-option")].find((b) => b.textContent === label);
    expect(option("Deny")?.getAttribute("aria-checked"), "seeded from storage").toBe("true");
    expect(clipboardPolicy.mode()).toBe("deny");
    act(() => option("Allow")?.click());
    expect(option("Allow")?.getAttribute("aria-checked")).toBe("true");
    expect(clipboardPolicy.mode()).toBe("allow");
    expect(localStorage.getItem("mast.terminal.clipboard-write")).toBe("allow");
    localStorage.removeItem("mast.terminal.clipboard-write");
    clipboardPolicy.reset();
  });

  test("the user menu's bell select is the stored setting", async () => {
    localStorage.setItem("mast.terminal.bell", "bounce");
    attentionStore.connect(localStorage, async () => {});
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="user-menu-trigger"]')?.click();
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="terminal-bell"] .select-trigger')!;
    expect(trigger.textContent, "seeded from storage").toContain("Bounce");
    act(() => trigger.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="option-flash"]')?.click());
    expect(trigger.textContent).toContain("Flash");
    expect(attentionStore.bell()).toBe("flash");
    expect(localStorage.getItem("mast.terminal.bell")).toBe("flash");
    localStorage.removeItem("mast.terminal.bell");
    act(() => attentionStore.reset());
  });

  test("the user menu's scrollback toggle is the stored setting", async () => {
    localStorage.setItem("mast.terminal.scrollback-mib", "50");
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="user-menu-trigger"]')?.click();
    });
    const section = container.querySelector('[data-testid="scrollback-budget"]');
    const option = (label: string) =>
      [...section!.querySelectorAll<HTMLButtonElement>(".toggle-option")].find((b) => b.textContent === label);
    expect(option("50 MB")?.getAttribute("aria-checked"), "seeded from storage").toBe("true");
    expect(scrollbackBudget.bytes()).toBe(50 * 1024 * 1024);
    act(() => option("5 MB")?.click());
    expect(option("5 MB")?.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("mast.terminal.scrollback-mib")).toBe("5");
    localStorage.removeItem("mast.terminal.scrollback-mib");
    scrollbackBudget.reset();
  });
});

describe("App pairing", () => {
  const GOOD_CODE = "sail1.eyJ2IjoxfQ";
  const NOT_A_CODE = "That does not look like a connect code; paste the whole code, starting with sail1.";
  const REVOKED = "This code was revoked on the box; ask for a new one.";
  const UNPAIRED: ConnectionStatus = {
    phase: "unpaired",
    server: "",
    loginOrigin: "",
    tokenPresent: false,
    tokenKind: "none",
    stream: "disconnected",
    paired: false,
  };
  const PAIRED_READY: ConnectionStatus = {
    phase: "ready",
    server: "127.0.0.1:7070",
    loginOrigin: "ssh://34.1.2.3",
    tokenPresent: true,
    tokenKind: "api",
    stream: "connected",
    paired: true,
    host: "34.1.2.3",
  };

  type Outcome = { ok: boolean; detail?: string };

  /** The app over a gateway whose connection the test owns: what `pair` and `forgetBox` answer,
   *  and the status the next read (or a push) reports. */
  async function renderPairing(
    initial: ConnectionStatus,
    answers: {
      pair?: Outcome;
      forget?: Outcome;
      afterForget?: ConnectionStatus;
      preview?: (code: string) => Promise<ConnectCodeCheck>;
    } = {},
    surfaces: Pick<Parameters<typeof App>[0], "terminal" | "deck"> = {},
  ) {
    gateway = createDemoGateway();
    let current = initial;
    const listeners = new Set<(status: ConnectionStatus) => void>();
    const calls = { pair: [] as string[], forget: 0, login: 0, logout: 0, catalogReads: 0 };
    const demo = gateway;
    const pairing = {
      ...gateway,
      listProjects: () => {
        calls.catalogReads += 1;
        return demo.listProjects();
      },
      connection: async () => current,
      onConnectionStatus: (listener: (status: ConnectionStatus) => void) => {
        listeners.add(listener);
        listener(current);
        return () => listeners.delete(listener);
      },
      whoami: async () => ({
        ok: true as const,
        value: current.paired
          ? { fde: "ada", name: "mast-ada", email: "ada@example.com", role: "member" as const, capabilities: [] }
          : { fde: "uday", name: "cli", email: "uday@example.com", role: "admin" as const, capabilities: [] },
      }),
      previewConnectCode:
        answers.preview ??
        (async (code: string): Promise<ConnectCodeCheck> =>
          code === GOOD_CODE
            ? { ok: true, value: { handle: "ada", email: "ada@example.com", host: "34.1.2.3" } }
            : { ok: false, detail: NOT_A_CODE }),
      pair: async (code: string) => {
        calls.pair.push(code);
        const outcome = answers.pair ?? { ok: true };
        if (outcome.ok) current = PAIRED_READY;
        return outcome;
      },
      forgetBox: async () => {
        calls.forget += 1;
        const outcome = answers.forget ?? { ok: true };
        if (outcome.ok) current = answers.afterForget ?? UNPAIRED;
        return outcome;
      },
      login: async () => {
        calls.login += 1;
        return { ok: false };
      },
      logout: async () => {
        calls.logout += 1;
      },
    };
    const theme = createThemeController(browserThemeDeps(() => {}));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<App gateway={pairing as never} theme={theme} {...surfaces} />));
    await flush();
    const push = async (status: ConnectionStatus) => {
      current = status;
      await act(async () => {
        for (const listener of listeners) listener(status);
      });
      await flush();
    };
    return { calls, push };
  }

  const at = <T extends HTMLElement>(testId: string) =>
    container.querySelector<T>(`[data-testid="${testId}"]`);

  const paste = async (text: string) => {
    const input = at<HTMLInputElement>("connect-code")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
  };

  const click = async (testId: string) => {
    await act(async () => at<HTMLButtonElement>(testId)!.click());
    await flush();
  };

  test("a Mac with no settings opens on the connect code field and names no file", async () => {
    await renderPairing(UNPAIRED);

    expect(at("connect-screen")).not.toBeNull();
    expect(at<HTMLInputElement>("connect-code")?.type, "the code is a secret on screen too").toBe("password");
    expect(at<HTMLButtonElement>("connect-pair")?.disabled).toBe(true);
    expect(at("connect-login"), "the passkey door is the fallback path's").toBeNull();
    expect(at("connect-code-error"), "an empty field is not an error").toBeNull();
    for (const word of ["config.yaml", "~/.ssh", "ssh-add", "passkey"]) {
      expect(at("connect-screen")!.textContent).not.toContain(word);
    }
    expect(at("view-rooms")).toBeNull();
  });

  test("a pasted code that parses shows who and where and arms Connect; one that does not says why", async () => {
    await renderPairing(UNPAIRED);

    await paste(GOOD_CODE);
    expect(at("connect-code-preview")?.textContent).toBe("ada@example.com on 34.1.2.3");
    expect(at<HTMLButtonElement>("connect-pair")?.disabled).toBe(false);

    await paste("hello");
    expect(at("connect-code-preview")).toBeNull();
    expect(at("connect-code-error")?.textContent).toBe(NOT_A_CODE);
    expect(at<HTMLButtonElement>("connect-pair")?.disabled).toBe(true);

    await paste("");
    expect(at("connect-code-error")).toBeNull();
    expect(at<HTMLButtonElement>("connect-pair")?.disabled).toBe(true);
  });

  test("a slow check of an earlier paste never overwrites the later one", async () => {
    const pending = new Map<string, (check: ConnectCodeCheck) => void>();
    await renderPairing(UNPAIRED, {
      preview: (code) => new Promise((resolve) => pending.set(code, resolve)),
    });

    await paste("hello");
    await paste(GOOD_CODE);
    await act(async () =>
      pending.get(GOOD_CODE)!({ ok: true, value: { handle: "ada", email: null, host: "34.1.2.3" } }),
    );
    await act(async () => pending.get("hello")!({ ok: false, detail: NOT_A_CODE }));

    expect(at("connect-code-preview")?.textContent, "a code with no email names the handle").toBe("ada on 34.1.2.3");
    expect(at("connect-code-error")).toBeNull();
  });

  test("connecting with a code lands on the rooms with the code's email in the user menu", async () => {
    const { calls } = await renderPairing(UNPAIRED);
    await paste(GOOD_CODE);
    await click("connect-pair");

    expect(calls.pair).toEqual([GOOD_CODE]);
    expect(at("connect-screen")).toBeNull();
    expect(at("view-rooms")).not.toBeNull();

    await click("user-menu-trigger");
    expect(at("user-menu-panel")!.textContent).toContain("ada@example.com");
    expect(at("user-menu-forget")).not.toBeNull();
    expect(at("user-menu-signout"), "a paired Mac leaves by forgetting the box").toBeNull();
  });

  test("a refused connection says why under the field and keeps the code there", async () => {
    const refusal =
      "The box at 34.1.2.3 answered with a different host key than the one in its connect code, so Mast refused it; pair again with a new code.";
    const { calls } = await renderPairing(UNPAIRED, { pair: { ok: false, detail: refusal } });
    await paste(GOOD_CODE);
    await click("connect-pair");

    expect(calls.pair).toEqual([GOOD_CODE]);
    expect(at("connect-code-error")?.textContent).toBe(refusal);
    expect(at<HTMLInputElement>("connect-code")?.value).toBe(GOOD_CODE);
    expect(at<HTMLButtonElement>("connect-pair")?.disabled, "the same code can be tried again").toBe(false);
    expect(at("view-rooms")).toBeNull();
  });

  test("a token revoked while running returns to the first-run screen naming the box", async () => {
    const { calls, push } = await renderPairing(PAIRED_READY);
    expect(at("view-rooms")).not.toBeNull();
    expect(catalogStore.specList().length).toBeGreaterThan(0);

    await push({ ...UNPAIRED, paired: true, host: "34.1.2.3", detail: REVOKED });

    expect(at("view-rooms"), "the gate owns the whole window").toBeNull();
    expect(at("connect-host")?.textContent).toBe("Paired with 34.1.2.3");
    expect(at("connect-reason")?.textContent).toBe(REVOKED);
    expect(at("connect-code")).not.toBeNull();
    expect(catalogStore.specList(), "the next code may be someone else's").toEqual([]);
    expect(calls.logout, "a paired Mac is never logged out").toBe(0);

    await paste(GOOD_CODE);
    await click("connect-pair");
    expect(at("connect-screen")).toBeNull();
    expect(at("view-rooms")).not.toBeNull();
  });

  test("Forget this box deletes the pairing and says the box still holds its side", async () => {
    const { calls } = await renderPairing(PAIRED_READY);
    await click("user-menu-trigger");
    await click("user-menu-forget");

    expect(calls.forget).toBe(1);
    expect(at("user-menu-panel")).toBeNull();
    expect(at("connect-code")).not.toBeNull();
    expect(at("connect-notice")?.textContent).toBe(FORGOTTEN_NOTICE);
    expect(FORGOTTEN_NOTICE).toContain("sail fde unpair");
    expect(at("connect-host")).toBeNull();

    await click("user-menu-trigger");
    expect(at("user-menu-forget"), "there is no box left to forget").toBeNull();
    expect(
      [...at("user-menu-panel")!.querySelectorAll("button")].find((b) => b.textContent === "Sign in with passkey")
        ?.disabled,
      "the passkey door is not offered on the first run",
    ).toBe(true);
  });

  test("forgetting a box on a Mac that still has the CLI's settings lands on them as their own person", async () => {
    const { calls } = await renderPairing(PAIRED_READY, {
      afterForget: { ...PAIRED_READY, paired: false, host: "devbox", tokenKind: "session" },
    });
    await click("user-menu-trigger");
    expect(at("user-menu-panel")!.textContent).toContain("ada@example.com");
    const readsOfTheForgottenBox = calls.catalogReads;
    await click("user-menu-forget");

    expect(calls.catalogReads, "the catalog is read again from the box now connected").toBeGreaterThan(
      readsOfTheForgottenBox,
    );
    expect(at("connect-screen")).toBeNull();
    expect(at("view-rooms")).not.toBeNull();
    await click("user-menu-trigger");
    expect(at("user-menu-panel")!.textContent).toContain("uday@example.com");
    expect(at("user-menu-panel")!.textContent).not.toContain("ada@example.com");
    expect(at("user-menu-forget")).toBeNull();
  });

  test("forgetting a box for the CLI's settings takes down what was open on it, and opens none of it on the next box", async () => {
    const mounted: string[] = [];
    const left: string[] = [];
    const Surface = ({ name }: { name: string }) => {
      useEffect(() => {
        mounted.push(name);
        return () => void left.push(name);
      }, [name]);
      return null;
    };
    await renderPairing(
      PAIRED_READY,
      { afterForget: { ...PAIRED_READY, paired: false, host: "devbox", tokenKind: "session" } },
      {
        terminal: (openRoomTerminal) => (
          <>
            <Surface name="terminal" />
            <button
              type="button"
              data-testid="open-room"
              onClick={() => openRoomTerminal({ roomId: "room-of-the-paired-box", project: "sail", title: "Design" })}
            />
          </>
        ),
        deck: { Workbench: ({ roomId }) => <Surface name={roomId} /> },
      },
    );
    await click("nav-terminal");
    await click("open-room");
    expect(mounted).toEqual(["terminal", "room-of-the-paired-box"]);

    await click("user-menu-trigger");
    await click("user-menu-forget");

    expect(left.toSorted()).toEqual(["room-of-the-paired-box", "terminal"]);
    expect(mounted, "the terminal starts over, and the forgotten box's room is not opened on this one").toEqual([
      "terminal",
      "room-of-the-paired-box",
      "terminal",
    ]);
    expect(at("view-room-terminal")).toBeNull();
    expect(at("view-rooms")).not.toBeNull();
  });

  test("a box that cannot be forgotten says why in the menu, and the workspace stays", async () => {
    const { calls } = await renderPairing(PAIRED_READY, {
      forget: { ok: false, detail: "Permission denied (os error 13)" },
    });
    await click("user-menu-trigger");
    await click("user-menu-forget");

    expect(calls.forget).toBe(1);
    expect(at("user-menu-forget-error")?.textContent).toBe("Permission denied (os error 13)");
    expect(at("view-rooms")).not.toBeNull();
    expect(at("connect-screen")).toBeNull();
  });

  test("a paired Mac that cannot reach its box says so without pointing at the CLI's file", async () => {
    const detail = "34.1.2.3 did not answer; check that the box is running and this Mac is online.";
    await renderPairing({ ...UNPAIRED, phase: "failed", paired: true, host: "34.1.2.3", detail });

    expect(at("connect-screen")!.textContent).toContain(detail);
    expect(at("connect-screen")!.textContent).not.toContain("config.yaml");
    await click("user-menu-trigger");
    expect(at("user-menu-forget"), "a pairing that cannot connect can still be forgotten").not.toBeNull();
  });

  test("a Mac on the CLI's settings keeps the passkey door and Sign out, and is offered no box to forget", async () => {
    await renderPairing({ ...PAIRED_READY, paired: false, tokenKind: "session" });
    await click("user-menu-trigger");
    expect(at("user-menu-signout")).not.toBeNull();
    expect(at("user-menu-forget")).toBeNull();
  });
});
