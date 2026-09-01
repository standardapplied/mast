import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ServerRoomView } from "../../shared/sail-models";
import { ToastProvider } from "../components/Toast";
import { createDemoGateway } from "../gateway";
import type { RoomTerminalRequest } from "../terminal/roomDeck";
import { sessionStore } from "../terminal/sessionStore";
import { ChatRoomPane } from "./ChatRoomPane";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => {
  await act(async () => {});
  await act(async () => {});
};

const room: ServerRoomView = {
  id: "design-talk",
  project: "sail-mast",
  title: "Design talk",
  members: [],
  spec_ids: [],
  created_at: "2026-06-30T10:00:00Z",
  updated_at: "2026-07-01T08:00:00Z",
};

async function render(requests: RoomTerminalRequest[]) {
  const gateway = createDemoGateway();
  sessionStore.reset();
  sessionStore.connect(gateway, "test-box");
  await act(async () => {
    root.render(
      <ToastProvider>
        <ChatRoomPane
          gateway={gateway}
          room={room}
          onOpenTerminal={(request) => requests.push(request)}
        />
      </ToastProvider>,
    );
  });
  await flush();
}

describe("ChatRoomPane terminal entries", () => {
  test("the deck cards surface in the header and navigate focused on the session", async () => {
    const requests: RoomTerminalRequest[] = [];
    await render(requests);
    const card = container.querySelector<HTMLButtonElement>(
      '[data-testid="deck-card-room-design-talk"]',
    );
    expect(card, "the demo room's live sessions render as header cards").not.toBeNull();
    await act(async () => card?.click());
    expect(requests).toEqual([
      {
        roomId: "design-talk",
        project: "sail-mast",
        title: "Design talk",
        focus: "room-design-talk",
      },
    ]);
  });

  test("Actions ▸ Open terminal ▸ Codex navigates with the launch request", async () => {
    const requests: RoomTerminalRequest[] = [];
    await render(requests);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="room-actions"]')?.click();
    });
    await flush();
    const openRow = [...document.querySelectorAll<HTMLElement>(".context-menu-row")].find((row) =>
      row.textContent?.includes("Open terminal"),
    );
    expect(openRow).not.toBeUndefined();
    await act(async () => {
      openRow?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await flush();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="deck-new-codex"]')?.click();
    });
    expect(requests).toEqual([
      { roomId: "design-talk", project: "sail-mast", title: "Design talk", launch: "codex" },
    ]);
  });
});
