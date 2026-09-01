import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SailEvent } from "../../shared/sail-models";
import { createDemoGateway, type Gateway } from "../gateway";
import type {
  DeckGlyph,
  RoomSessionGroup,
  SessionEntry,
} from "../terminal/roomDeck";
import { connectSessions, sessionStore } from "../terminal/sessionStore";
import { openTerminalMenu, RoomDeckStrip, RoomsInventory } from "./RoomDeck";

let container: HTMLDivElement;
let root: Root;
let disconnect: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStore.reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  disconnect?.();
  disconnect = null;
});

const flush = async () => {
  await act(async () => {});
  await act(async () => {});
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

const componentsCss = await Bun.file(
  new URL("../static/components.css", import.meta.url).pathname,
).text();

// happy-dom computes no layout, so the geometry contracts live in the stylesheet.
describe("stylesheet contracts", () => {
  test("room-conversation stacks its children as a column", () => {
    const block = componentsCss.match(/\.room-conversation \{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("flex-direction: column");
  });

  test("the in-room stage, its bar, and the deck popover are gone from the stylesheet", () => {
    expect(componentsCss).not.toContain(".room-stage-bar");
    expect(componentsCss).not.toContain(".room-deck-panel");
    expect(componentsCss).not.toContain(".deck-pop");
    expect(componentsCss).not.toContain(".deck-trigger");
  });

  test("the route is full-bleed: no intermediary re-shapes the workbench", () => {
    const body = componentsCss.match(/\.room-route__body \{[^}]*\}/)?.[0] ?? "";
    expect(body).toContain("flex: 1");
    expect(body).not.toContain("padding");
    expect(body).not.toContain("max-width");
    const terminal = componentsCss.match(/\.room-terminal \{[^}]*\}/)?.[0] ?? "";
    expect(terminal).toContain("flex: 1");
    expect(terminal).not.toContain("padding");
    expect(terminal).not.toContain("max-width");
  });

  test("the route bar matches the viewer bar height so borders align", () => {
    const routeBar = componentsCss.match(/\.room-route__bar \{[^}]*\}/)?.[0] ?? "";
    const viewerBar = componentsCss.match(/\.viewer__bar \{[^}]*\}/)?.[0] ?? "";
    expect(routeBar).toContain("height: 40px");
    expect(viewerBar).toContain("height: 40px");
  });
});

describe("openTerminalMenu", () => {
  test("is one Actions submenu offering Shell / Claude Code / Codex", () => {
    const opened: DeckGlyph[] = [];
    const node = openTerminalMenu((glyph) => opened.push(glyph));
    if (node.kind !== "item") throw new Error("expected an item node");
    expect(node.label).toBe("Open terminal");
    expect(node.submenu).toHaveLength(3);
    for (const entry of node.submenu!) {
      if (entry.kind !== "item") throw new Error("expected item entries");
      entry.onSelect?.();
    }
    expect(opened).toEqual(["shell", "claude", "codex"]);
  });
});

describe("RoomDeckStrip", () => {
  async function renderStrip(gateway: Gateway, onSelect: (name: string) => void = () => {}) {
    disconnect = connectSessions(gateway, sessionStore);
    await act(async () => {
      root.render(<RoomDeckStrip roomId="design-talk" onSelect={onSelect} />);
    });
    await flush();
  }

  test("a room with no sessions reserves nothing", async () => {
    const gateway: Gateway = {
      ...createDemoGateway(),
      listSessions: async () => ({ ok: true, value: [] }),
    };
    await renderStrip(gateway);
    expect(container.querySelector('[data-testid="deck-strip"]')).toBeNull();
  });

  test("cards render for this room only, corpses dimmed with their yield reason", async () => {
    await renderStrip(createDemoGateway());
    expect(container.querySelector('[data-testid="deck-card-room-design-talk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="deck-card-room-design-talk.2"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="deck-card-mast-node"]'),
      "sessions bound to no room stay out of the header",
    ).toBeNull();
    const corpse = container.querySelector('[data-testid="deck-card-resume-demo-run-7"]');
    expect(corpse?.className).toContain("is-ended");
    expect(corpse?.textContent).toContain("ended");
  });

  test("clicking a card reports the session to navigate to", async () => {
    const picked: string[] = [];
    await renderStrip(createDemoGateway(), (name) => picked.push(name));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="deck-card-room-design-talk.2"]')
        ?.click();
    });
    expect(picked).toEqual(["room-design-talk.2"]);
  });

  test("a session another client opens appears when its pty event lands", async () => {
    const base = createDemoGateway();
    const sessions: SessionEntry[] = [];
    const gateway: Gateway = {
      ...base,
      listSessions: async () => ({ ok: true, value: [...sessions] }),
    };
    await renderStrip(gateway);
    expect(container.querySelector('[data-testid="deck-strip"]')).toBeNull();

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
    expect(container.querySelector('[data-testid="deck-card-room-design-talk"]')).not.toBeNull();
  });

  test("a handshake skew becomes the warn chip naming the older side", async () => {
    const gateway: Gateway = {
      ...createDemoGateway(),
      listSessions: async () => ({
        ok: false,
        error: {
          status: 0,
          code: "pty_unreachable",
          message: "pty protocol skew: the box speaks SAILPTY1",
        },
      }),
    };
    await renderStrip(gateway);
    expect(container.querySelector('[data-testid="deck-skew"]')?.textContent).toContain(
      "This box's sail is older than Mast",
    );
    expect(container.querySelector('[data-testid^="deck-card-"]')).toBeNull();
  });
});

describe("RoomsInventory", () => {
  const groups: RoomSessionGroup[] = [
    {
      roomId: "design-talk",
      title: "Design talk",
      project: "sail-mast",
      sessions: [
        {
          name: "room-design-talk",
          live: true,
          attached: 1,
          writerFde: "uday",
          room: "design-talk",
          command: ["claude"],
        },
        {
          name: "resume-run-7",
          live: false,
          attached: 0,
          writerFde: "",
          room: "design-talk",
          command: ["codex"],
        },
      ],
    },
  ];

  async function renderInventory(
    onJump: (group: RoomSessionGroup<SessionEntry>, session: SessionEntry) => void = () => {},
    onKill: (session: SessionEntry) => void = () => {},
  ) {
    await act(async () => {
      root.render(<RoomsInventory groups={groups} onJump={onJump} onKill={onKill} />);
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="rooms-inventory-trigger"]')
        ?.click();
    });
    await flush();
  }

  test("collapsed by default; open lists sessions under the room's title", async () => {
    await act(async () => {
      root.render(<RoomsInventory groups={groups} onJump={() => {}} onKill={() => {}} />);
    });
    await flush();
    expect(document.querySelector('[data-testid="rooms-inventory"]')).toBeNull();
    const trigger = container.querySelector('[data-testid="rooms-inventory-trigger"]');
    expect(trigger?.textContent).toContain("Rooms");
    expect(trigger?.textContent).toContain("1");

    await act(async () => {
      (trigger as HTMLButtonElement)?.click();
    });
    await flush();
    const panel = document.querySelector('[data-testid="rooms-inventory"]');
    expect(panel?.textContent).toContain("Design talk");
    expect(panel?.querySelector('[data-testid="inventory-room-design-talk"]')).not.toBeNull();
    expect(panel?.querySelector('[data-testid="inventory-resume-run-7"]')?.className).toContain(
      "is-ended",
    );
  });

  test("no room sessions, no trigger — the strip stays clean", async () => {
    await act(async () => {
      root.render(<RoomsInventory groups={[]} onJump={() => {}} onKill={() => {}} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="rooms-inventory-trigger"]')).toBeNull();
  });

  test("a row jumps to the session's home room", async () => {
    const jumps: string[] = [];
    await renderInventory((group, session) => jumps.push(`${group.roomId}:${session.name}`));
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="inventory-room-design-talk"]')
        ?.click();
    });
    expect(jumps).toEqual(["design-talk:room-design-talk"]);
  });

  test("the kill verb parks on the confirm before ending the session", async () => {
    const killed: string[] = [];
    await renderInventory(
      () => {},
      (session) => killed.push(session.name),
    );
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Close session room-design-talk"]')
        ?.click();
    });
    await flush();
    expect(killed).toEqual([]);
    expect(document.body.textContent).toContain("Close session room-design-talk?");
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Close" && button.className.includes("btn-danger"),
    );
    // A real press dispatches pointerdown before click; the dialog portals outside
    // the panel, so this is exactly the sequence that must not dismiss it.
    await act(async () => {
      confirm?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await act(async () => confirm?.click());
    expect(killed).toEqual(["room-design-talk"]);
    expect(
      document.querySelector('[data-testid="rooms-inventory"]'),
      "the panel stays open so a refusal lands where the click happened",
    ).not.toBeNull();
  });

  test("a refused kill renders inline on the row that asked for it", async () => {
    const refused: Array<RoomSessionGroup<SessionEntry>> = [
      {
        roomId: "design-talk",
        title: "Design talk",
        project: "sail-mast",
        sessions: [
          {
            name: "room-design-talk",
            live: true,
            attached: 1,
            writerFde: "uday",
            room: "design-talk",
            command: ["claude"],
            refusal: "room design-talk unresolved: no room 'design-talk'",
          },
        ],
      },
    ];
    await act(async () => {
      root.render(<RoomsInventory groups={refused} onJump={() => {}} onKill={() => {}} />);
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="rooms-inventory-trigger"]')
        ?.click();
    });
    await flush();
    expect(
      document.querySelector('[data-testid="refusal-room-design-talk"]')?.textContent,
    ).toContain("no room 'design-talk'");
  });
});
