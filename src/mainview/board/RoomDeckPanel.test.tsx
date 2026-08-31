import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SailEvent } from "../../shared/sail-models";
import { createDemoGateway, type Gateway } from "../gateway";
import type { DeckServices, DeckSession, RoomTerminalProps } from "../terminal/roomDeck";
import { RoomDeckPanel } from "./RoomDeckPanel";

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

const terminals: RoomTerminalProps[] = [];
const services: DeckServices = {
  Terminal: (props) => {
    terminals.push(props);
    return <div data-testid={`fake-terminal-${props.session}`} data-command={props.command.join(" ")} />;
  },
};

function ptyEvent(over: Partial<SailEvent>): SailEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    project: "sail-mast",
    spec: "design-talk",
    type: "pty_session_started",
    agent: "mady",
    host: "devbox",
    data: { room_id: "design-talk" },
    ...over,
  };
}

async function renderPanel(gateway: Gateway, withServices = false) {
  await act(async () => {
    root.render(
      <RoomDeckPanel
        gateway={gateway}
        roomId="design-talk"
        project="sail-mast"
        services={withServices ? services : undefined}
      >
        <div data-testid="conversation" />
      </RoomDeckPanel>,
    );
  });
  await flush();
}

const componentsCss = await Bun.file(
  new URL("../static/components.css", import.meta.url).pathname,
).text();

// happy-dom computes no layout, so the stacking contract lives in the stylesheet:
// the deck strip, and the header above it in chat rooms, stack vertically only
// because .room-conversation declares a column — without it the strip renders as
// a collapsed left sliver (the 0.1.70 field bug).
test("room-conversation stacks its children as a column", () => {
  const block = componentsCss.match(/\.room-conversation \{[^}]*\}/)?.[0] ?? "";
  expect(block).toContain("flex-direction: column");
});

describe("RoomDeckPanel", () => {
  test("lists only the room's sessions as chips, corpse marked ended", async () => {
    await renderPanel(createDemoGateway());
    expect(container.querySelector('[data-testid="deck-chip-room-design-talk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="deck-chip-room-design-talk.2"]')).not.toBeNull();
    const corpse = container.querySelector('[data-testid="deck-chip-resume-demo-run-7"]');
    expect(corpse?.className).toContain("is-ended");
    expect(corpse?.textContent).toContain("ended");
    expect(
      container.querySelector('[data-testid="deck-chip-mast-node"]'),
      "sessions bound to no room stay in the Terminal view",
    ).toBeNull();
    expect(container.querySelector('[data-testid="conversation"]')).not.toBeNull();
  });

  test("a session another client opens appears when its pty event lands", async () => {
    const base = createDemoGateway();
    const sessions: DeckSession[] = [];
    const gateway: Gateway = {
      ...base,
      listSessions: async () => ({ ok: true, value: [...sessions] }),
    };
    await renderPanel(gateway);
    expect(container.querySelector('[data-testid="deck-chip-room-design-talk"]')).toBeNull();

    sessions.push({
      name: "room-design-talk",
      live: true,
      attached: 1,
      writerFde: "mady",
      room: "design-talk",
      command: ["claude"],
    });
    await act(async () => {
      base.emit(ptyEvent({ data: { room_id: "design-talk", session: "room-design-talk" } }));
    });
    await flush();
    const chip = container.querySelector('[data-testid="deck-chip-room-design-talk"]');
    expect(chip, "the deck refreshes on the room's pty events").not.toBeNull();
    expect(chip?.textContent).toContain("M");
  });

  test("a yielded resume corpse shows the reason and withholds Reopen while the dispatch runs", async () => {
    // The demo yield names mast-kanban-board, whose demo build run is running.
    await renderPanel(createDemoGateway(), true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-chip-resume-demo-run-7"]')
        ?.click();
    });
    await flush();
    const card = container.querySelector('[data-testid="deck-ended-card"]');
    expect(card?.textContent).toContain("yielded to dispatch demo-run-8 of spec mast-kanban-board");
    expect(card?.textContent).toContain("A dispatch is live");
    expect(card?.textContent).not.toContain("Reopen");
  });

  test("a yielded corpse reopens once no dispatch is live on its spec", async () => {
    const base = createDemoGateway();
    const gateway: Gateway = {
      ...base,
      listRuns: async (specId) => ({ ok: true, value: { spec: specId, runs: [] } }),
    };
    terminals.length = 0;
    await renderPanel(gateway, true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-chip-resume-demo-run-7"]')
        ?.click();
    });
    await flush();
    const reopen = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Reopen",
    );
    expect(reopen).not.toBeNull();
    await act(async () => reopen?.click());
    await flush();
    const revived = terminals.find((t) => t.session === "resume-demo-run-7");
    expect(revived?.killFirst).toBe(true);
    expect(revived?.command).toEqual(["codex", "resume"]);
  });

  test("a failed dispatch lookup keeps Reopen withheld", async () => {
    const base = createDemoGateway();
    const gateway: Gateway = {
      ...base,
      listRuns: async () => ({
        ok: false as const,
        error: { status: 500, code: "unreachable", message: "backend down" },
      }),
    };
    await renderPanel(gateway, true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-chip-resume-demo-run-7"]')
        ?.click();
    });
    await flush();
    const card = container.querySelector('[data-testid="deck-ended-card"]');
    expect(card?.textContent).not.toContain("Reopen");
  });

  test("the open-terminal verb mints a room-bound session and attaches in place", async () => {
    terminals.length = 0;
    await renderPanel(createDemoGateway(), true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open terminal"]')?.click();
    });
    const claude = [...container.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
      (item) => item.textContent?.includes("Claude Code"),
    );
    expect(claude).not.toBeNull();
    await act(async () => claude?.click());
    await flush();
    // room-design-talk and .2 exist on the host, so the fresh one takes .3.
    const opened = terminals.find((t) => t.session === "room-design-talk.3");
    expect(opened).toBeDefined();
    expect(opened?.command).toEqual(["claude"]);
    expect(opened?.room).toBe("design-talk");
    expect(opened?.project).toBe("sail-mast");
    expect(
      container.querySelector('[data-testid="fake-terminal-room-design-talk.3"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="deck-chip-room-design-talk.3"]'),
      "the fresh session chips optimistically before the host lists it",
    ).not.toBeNull();
  });

  test("without the Tauri edge a live chip explains where attaching lives", async () => {
    await renderPanel(createDemoGateway());
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-chip-room-design-talk"]')
        ?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="deck-attach-unavailable"]')).not.toBeNull();
  });

  test("a handshake skew replaces the chips with the card naming the older side", async () => {
    const base = createDemoGateway();
    const gateway: Gateway = {
      ...base,
      listSessions: async () => ({
        ok: false,
        error: {
          status: 0,
          code: "pty_unreachable",
          message: "pty protocol skew: the box speaks SAILPTY1",
        },
      }),
    };
    await renderPanel(gateway);
    const deck = container.querySelector('[data-testid="room-deck"]');
    expect(deck?.textContent).toContain("This box's sail is older than Mast");
    expect(deck?.textContent).toContain("sail upgrade");
    expect(container.querySelector('[data-testid^="deck-chip-"]')).toBeNull();
  });
});
