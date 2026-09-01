import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Gateway } from "../gateway";
import type { DeckSession } from "../terminal/roomDeck";
import { useRoomSessions } from "./useRoomSessions";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
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

function session(over: Partial<DeckSession>): DeckSession {
  return {
    name: "room-design-talk",
    live: true,
    attached: 1,
    writerFde: "uday",
    room: "design-talk",
    command: ["bash", "-l"],
    ...over,
  };
}

/**
 * A host whose pty event lane is fully dead: sessions come and go on the box,
 * no event ever announces it. Correctness must hold on the reconcile points
 * alone — events only accelerate.
 */
function makeEventlessGateway(hostSessions: DeckSession[]) {
  const gateway = {
    listSessions: async () => ({ ok: true as const, value: [...hostSessions] }),
    killSession: async (name: string) => {
      const index = hostSessions.findIndex((s) => s.name === name);
      if (index >= 0) hostSessions.splice(index, 1);
      return { ok: true as const, value: { session: name } };
    },
    getRoom: async (id: string) => ({
      ok: true as const,
      value: {
        id,
        project: "sail-mast",
        title: id,
        members: [],
        spec_ids: [],
        created_at: "",
        updated_at: "",
      },
    }),
    specEvents: async (id: string) => ({
      ok: true as const,
      value: { spec: id, limit: 100, returned: 0, events: [] },
    }),
    onEvent: () => () => {},
    onConnectionStatus: () => () => {},
  };
  return gateway as unknown as Gateway;
}

/** Two live surfaces over the same room: the header deck and the route's workbench. */
function Surfaces({ gateway }: { gateway: Gateway }) {
  const deck = useRoomSessions(gateway, "design-talk");
  const route = useRoomSessions(gateway, "design-talk");
  return (
    <div>
      <div data-testid="deck-names">
        {deck.sessions === null ? "…" : deck.sessions.map((s) => s.name).join(",")}
      </div>
      <button
        type="button"
        data-testid="route-reconcile"
        onClick={() => route.refresh()}
      />
    </div>
  );
}

const deckNames = () =>
  container.querySelector('[data-testid="deck-names"]')?.textContent ?? "";

describe("one owner for the session inventory (field round 2026-09-01)", () => {
  test("a session created via the route seam reaches the deck with the event lane dead", async () => {
    const host: DeckSession[] = [];
    const gateway = makeEventlessGateway(host);
    await act(async () => {
      root.render(<Surfaces gateway={gateway} />);
    });
    await flush();
    expect(deckNames()).toBe("");

    // The route's pane creates the session on the host (attach ack), then hits
    // its deterministic reconcile point. No pty event is ever delivered.
    host.push(session({}));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="route-reconcile"]')
        ?.click();
    });
    await flush();

    expect(
      deckNames(),
      "the deck must show the session another surface observed — the inventory has one owner",
    ).toBe("room-design-talk");
  });

  test("a kill observed by one surface converges every other surface without any event", async () => {
    const host: DeckSession[] = [session({})];
    const gateway = makeEventlessGateway(host);
    await act(async () => {
      root.render(<Surfaces gateway={gateway} />);
    });
    await flush();
    expect(deckNames()).toBe("room-design-talk");

    await act(async () => {
      await gateway.killSession("room-design-talk");
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="route-reconcile"]')
        ?.click();
    });
    await flush();

    expect(
      deckNames(),
      "the deck must drop the killed session another surface observed",
    ).toBe("");
  });
});
