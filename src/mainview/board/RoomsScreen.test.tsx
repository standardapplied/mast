import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PruneRequest } from "../../shared/sail-models";
import { ToastProvider } from "../components/Toast";
import { createDemoGateway, type DemoGateway } from "../gateway";
import { RoomsScreen } from "./RoomsScreen";

let root: Root;
let container: HTMLElement;

async function render(gateway: DemoGateway = createDemoGateway()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <RoomsScreen gateway={gateway} onOpenTerminal={() => {}} />
      </ToastProvider>,
    ),
  );
  await act(async () => {});
  await act(async () => {});
  return gateway;
}

beforeEach(() => {
  localStorage.removeItem("mast.rooms.watermarks");
  localStorage.removeItem("mast.rooms.selections");
  localStorage.removeItem("mast.rooms.sidebar.width");
  localStorage.removeItem("mast.rooms.archive.open");
  localStorage.removeItem("mast.room.details.rooms.open");
  localStorage.removeItem("mast.room.details.board.open");
  localStorage.removeItem("mast.room.details.width");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function withHomeRoom(gateway: DemoGateway = createDemoGateway()) {
  const created = await gateway.createRoom({
    id: "chorus--uday",
    project: "chorus",
    title: "chorus",
  });
  if (!created.ok) throw new Error(created.error.message);
  created.value.created_at = created.value.updated_at = "2026-01-01T00:00:00Z";
  await gateway.engage("chorus--uday", { agent: "claude-code" });
  return gateway;
}

const selectedRow = () =>
  container.querySelector<HTMLElement>('.room-row[aria-current="page"]')?.dataset.testid;

const homeRow = () => {
  const first = container.querySelector(".room-list-scroll > .room-section");
  if (!first || first.querySelector(".room-section-head")) return undefined;
  return first.querySelector<HTMLElement>(".room-row")?.dataset.testid;
};

describe("RoomsScreen", () => {
  test("a project's first visit opens the viewer's conversation with its agent", async () => {
    await render(await withHomeRoom());

    expect(selectedRow()).toBe("room-chorus--uday");
    expect(container.querySelector(".room-header-id")?.textContent).toBe("chorus--uday");
    const first = container.querySelector<HTMLElement>(".room-row");
    expect(first?.dataset.testid).toBe("room-chorus--uday");
    expect(first?.querySelector(".room-row-id-label")?.textContent).toBe("chorus");
  });

  test("a room picked before whoami landed gives way to the home room", async () => {
    const gateway = await withHomeRoom();
    const whoami = gateway.whoami;
    const pending: Array<() => void> = [];
    const identify = () => pending.splice(0).forEach((answer) => answer());
    gateway.whoami = () =>
      new Promise((resolve) => {
        pending.push(() => void whoami().then(resolve));
      });

    await render(gateway);
    expect(selectedRow()).not.toBe("room-chorus--uday");

    await act(async () => identify());
    await act(async () => {});
    await act(async () => {});

    expect(selectedRow()).toBe("room-chorus--uday");
  });

  test("a project read that failed is asked again on the next refresh", async () => {
    const gateway = await withHomeRoom();
    const project = gateway.project;
    let down = true;
    gateway.project = (name) =>
      down
        ? Promise.resolve({
            ok: false as const,
            error: { status: 503, code: "unavailable", message: "down" },
          })
        : project(name);

    await render(gateway);
    expect(homeRow()).toBeUndefined();

    down = false;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => {});
    await act(async () => {});

    expect(homeRow()).toBe("room-chorus--uday");
    expect(selectedRow()).toBe("room-chorus--uday");
  });

  test("a room the viewer chose last time still wins over the home room", async () => {
    localStorage.setItem(
      "mast.rooms.selections",
      JSON.stringify({ chorus: "chorus-billing-export" }),
    );

    await render(await withHomeRoom());

    expect(selectedRow()).toBe("room-chorus-billing-export");
  });

  test("keeps details closed by default and opens body, dependencies, and history in the drawer", async () => {
    await render();

    expect(container.querySelector(".room-details-drawer")).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="room-chorus-ledger-sync"]')?.click(),
    );
    await act(async () => {});
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="details-toggle"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Details");

    act(() => toggle.click());
    await act(async () => {});

    const drawer = container.querySelector(".room-details-drawer");
    expect(drawer?.textContent).toContain("Spec");
    expect(drawer?.textContent).toContain("Dependencies");
    expect(drawer?.textContent).toContain("History");
    expect(localStorage.getItem("mast.room.details.rooms.open")).toBe("true");

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close details"]')?.click(),
    );
    expect(container.querySelector(".room-details-drawer")).toBeNull();
    expect(localStorage.getItem("mast.room.details.rooms.open")).toBe("false");
  });

  test("ignores late detail responses after selecting another room", async () => {
    const gateway = createDemoGateway();
    const getSpec = gateway.getSpec;
    const getSpecContent = gateway.getSpecContent;
    const initialDetail = await getSpec("chorus-auth-flow");
    const initialContent = await getSpecContent("chorus-auth-flow");
    let resolveDetail!: (value: typeof initialDetail) => void;
    let resolveContent!: (value: typeof initialContent) => void;
    const delayedDetail = new Promise<typeof initialDetail>((resolve) => {
      resolveDetail = resolve;
    });
    const delayedContent = new Promise<typeof initialContent>((resolve) => {
      resolveContent = resolve;
    });
    gateway.getSpec = (id) => id === "chorus-auth-flow" ? delayedDetail : getSpec(id);
    gateway.getSpecContent = (id) =>
      id === "chorus-auth-flow" ? delayedContent : getSpecContent(id);

    await render(gateway);
    const next = container.querySelector<HTMLButtonElement>(
      '[data-testid="room-chorus-billing-export"]',
    );
    await act(async () => next?.click());
    await act(async () => {});
    expect(container.querySelector(".detail-title")?.textContent).toBe(
      "Billing export to NetSuite",
    );

    await act(async () => {
      resolveDetail(initialDetail);
      resolveContent(initialContent);
      await Promise.all([delayedDetail, delayedContent]);
    });
    await act(async () => {});

    expect(container.querySelector(".detail-title")?.textContent).toBe(
      "Billing export to NetSuite",
    );
  });

  test("creates a chat room from only a title and opens it", async () => {
    const gateway = await render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="New room"]')?.click();
    });
    expect(
      container.querySelector('[role="dialog"]'),
      "creating a room opens a modal (bottom sheet on narrow viewports), not an inline form",
    ).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Room title"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "Fresh planning room");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create");
    expect(create?.disabled).toBe(false);
    await act(async () => {
      create?.click();
    });
    await act(async () => {});
    await act(async () => {});

    expect(container.querySelector('[data-testid="room-fresh-planning-room"]')).not.toBeNull();
    expect(container.querySelector(".detail-title")?.textContent).toBe("Fresh planning room");
    expect(container.querySelector(".room-header-id")?.textContent).toBe("fresh-planning-room");
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="details-toggle"]')?.click();
    });
    await act(async () => {});
    expect(
      container.querySelector("#room-details-drawer")?.textContent,
      "a chat room's drawer lists the specs born here — empty for a fresh room",
    ).toContain("None yet");

    const listed = await gateway.listRooms("chorus");
    const created = listed.ok
      ? listed.value.rooms.find((room) => room.id === "fresh-planning-room")
      : undefined;
    expect(created?.spec_ids).toEqual([]);

    const specs = await gateway.listSpecs({ project: "chorus" });
    expect(specs.ok && specs.value.specs.some((spec) => spec.id === "fresh-planning-room")).toBe(
      false,
    );
  });

  test("archive toggle reveals done rooms and their composer is read-only", async () => {
    await render();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="archive-section"]')?.click();
    });
    const done = container.querySelector<HTMLButtonElement>('[data-testid="room-chorus-onboarding"]');
    expect(done).not.toBeNull();
    await act(async () => done?.click());
    await act(async () => {});
    await act(async () => {});

    expect(container.querySelector('[aria-label="Message this room"]')).toBeNull();
    expect(container.querySelector(".room-readonly")?.textContent).toContain("read-only");
  });

  test("a room cancelled elsewhere keeps its pane but leaves the sidebar until archive is shown", async () => {
    const gateway = await render();
    const room = container.querySelector<HTMLButtonElement>(
      '[data-testid="room-chorus-billing-export"]',
    );
    await act(async () => room?.click());
    await act(async () => {});

    await act(async () => {
      await gateway.updateSpec("chorus-billing-export", { status: "cancelled" });
    });
    await act(async () => {});
    await act(async () => {});

    expect(container.querySelector('[data-testid="room-chorus-billing-export"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="archive-section"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container.querySelector(".room-system-row")?.textContent).toContain(
      "status changed to cancelled",
    );

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="archive-section"]')?.click();
    });
    expect(
      container.querySelector('[data-testid="room-chorus-billing-export"]')?.classList
        .contains("is-selected"),
    ).toBe(true);
  });

  test("the open archive prunes the archived specs chosen, the caller's own checked, and the rows leave on the ack", async () => {
    const gateway = createDemoGateway();
    await gateway.updateSpec("chorus-onboarding", { status: "archived" });
    await gateway.updateSpec("chorus-ledger-sync", { status: "archived" });
    gateway.onEvent = () => () => {};
    const calls: PruneRequest[] = [];
    const prune = gateway.pruneSpecs.bind(gateway);
    gateway.pruneSpecs = (request) => {
      calls.push(request);
      return prune(request);
    };
    await render(gateway);
    expect(container.querySelector('[data-testid="prune-archived"]')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="archive-section"]')?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="prune-archived"]')?.click();
    });
    await act(async () => {});
    await act(async () => {});

    const choice = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="prune-choice-${id}"] [role="checkbox"]`,
      )!;
    expect(container.textContent).toContain("Prune archived specs?");
    expect(choice("chorus-onboarding").getAttribute("aria-checked")).toBe("true");
    expect(choice("chorus-ledger-sync").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[data-testid="prune-report"]')?.textContent).toStartWith(
      "Erases chorus-onboarding and its room from every box",
    );
    expect(calls).toEqual([{ ids: ["chorus-onboarding"], dry_run: true }]);
    expect(container.querySelector('[data-testid="prune-report"]')).not.toBeNull();

    await act(async () => choice("chorus-ledger-sync").click());
    await act(async () => {});
    expect(calls.at(-1)).toEqual({
      ids: expect.arrayContaining(["chorus-onboarding", "chorus-ledger-sync"]),
      dry_run: true,
    });
    await act(async () => choice("chorus-ledger-sync").click());
    await act(async () => {});

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="prune-go"]')?.click();
    });
    await act(async () => {});
    await act(async () => {});

    expect(calls.at(-1)).toEqual({ ids: ["chorus-onboarding"], dry_run: false });
    expect(container.textContent).toContain("Pruned chorus-onboarding everywhere.");
    expect(container.querySelector('[data-testid="room-chorus-onboarding"]')).toBeNull();
    expect(container.querySelector('[data-testid="room-chorus-ledger-sync"]')).not.toBeNull();
  });
});
