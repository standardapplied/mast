import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
        <RoomsScreen gateway={gateway} active />
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

describe("RoomsScreen", () => {
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
});
