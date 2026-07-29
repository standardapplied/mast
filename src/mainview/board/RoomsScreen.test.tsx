import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "../components/Toast";
import { createDemoGateway } from "../gateway";
import { RoomsScreen } from "./RoomsScreen";

let root: Root;
let container: HTMLElement;

async function render() {
  const gateway = createDemoGateway();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <RoomsScreen gateway={gateway} />
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RoomsScreen", () => {
  test("creates a draft room from only a title and opens it", async () => {
    const gateway = await render();
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New room")
        ?.click();
    });
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
    expect(container.querySelector(".detail-title")?.textContent).toBe("fresh-planning-room");
    expect(container.querySelector(".detail-draft-note")?.textContent).toContain("Draft");

    const listed = await gateway.listSpecs({ project: "chorus" });
    expect(listed.ok && listed.value.specs.some((spec) => spec.id === "fresh-planning-room")).toBe(
      true,
    );
  });

  test("archive toggle reveals done rooms and their composer is read-only", async () => {
    await render();
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Show done & cancelled")
        ?.click();
    });
    const done = container.querySelector<HTMLButtonElement>('[data-testid="room-chorus-onboarding"]');
    expect(done).not.toBeNull();
    await act(async () => done?.click());
    await act(async () => {});
    await act(async () => {});

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Message this room"]')?.disabled)
      .toBe(true);
  });

  test("a room cancelled elsewhere stays selected and moves into the revealed archive", async () => {
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

    expect(
      container.querySelector('[data-testid="room-chorus-billing-export"]')?.classList
        .contains("is-selected"),
    ).toBe(true);
    expect(container.querySelector(".detail-header-actions")?.textContent).toContain("Cancelled");
    expect(container.querySelector(".room-archive-toggle")?.textContent).toBe("Hide archive");
    expect(container.querySelector(".room-system-row")?.textContent).toContain(
      "Status changed to cancelled",
    );
  });
});
