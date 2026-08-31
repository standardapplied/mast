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

async function renderPanel(gateway: Gateway, withServices = false, active = true) {
  await act(async () => {
    root.render(
      <RoomDeckPanel
        gateway={gateway}
        roomId="design-talk"
        project="sail-mast"
        title="Design talk"
        active={active}
        services={withServices ? services : undefined}
        header={(deckControl) => <header data-testid="room-header">{deckControl}</header>}
      >
        <div data-testid="conversation" />
      </RoomDeckPanel>,
    );
  });
  await flush();
}

/** The deck popover portals to the body; open it through the header trigger. */
async function openDeck() {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="deck-trigger"]')?.click();
  });
  await flush();
}

async function pickCard(session: string) {
  await openDeck();
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="deck-card-${session}"]`)?.click();
  });
  await flush();
}

function emptyGateway(): Gateway {
  return { ...createDemoGateway(), listSessions: async () => ({ ok: true, value: [] }) };
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

  test("the always-on strip is gone from the stylesheet", () => {
    expect(componentsCss).not.toContain(".room-deck {");
    expect(componentsCss).not.toContain(".room-deck__chip");
  });

  test("the stage is full-bleed: no intermediary re-shapes the pane host", () => {
    const stage = componentsCss.match(/\.room-deck-panel__stage \{[^}]*\}/)?.[0] ?? "";
    expect(stage).toContain("flex: 1");
    expect(stage).not.toContain("padding");
    expect(stage).not.toContain("max-width");
    const terminal = componentsCss.match(/\.room-terminal \{[^}]*\}/)?.[0] ?? "";
    expect(terminal).toContain("flex: 1");
    expect(terminal).not.toContain("padding");
    expect(terminal).not.toContain("max-width");
  });

  test("the stage bar matches the viewer bar height so borders align", () => {
    const stageBar = componentsCss.match(/\.room-stage-bar \{[^}]*\}/)?.[0] ?? "";
    const viewerBar = componentsCss.match(/\.viewer__bar \{[^}]*\}/)?.[0] ?? "";
    expect(stageBar).toContain("height: 40px");
    expect(viewerBar).toContain("height: 40px");
  });
});

describe("RoomDeckPanel", () => {
  test("an empty room reserves nothing: just the header verb, click = the picker", async () => {
    await renderPanel(emptyGateway(), true);
    const trigger = container.querySelector('[data-testid="deck-trigger"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Open terminal");
    expect(container.querySelector('[data-testid="deck-count"]')).toBeNull();
    expect(document.querySelector('[data-testid="deck-pop"]')).toBeNull();
    expect(container.querySelector('[data-testid="room-stage-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="conversation"]')).not.toBeNull();

    await openDeck();
    expect(document.querySelector('[data-testid="deck-pop"]'), "no deck to open").toBeNull();
    const claude = [...document.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
      (item) => item.textContent?.includes("Claude Code"),
    );
    expect(claude).not.toBeNull();
    terminals.length = 0;
    await act(async () => claude?.click());
    await flush();
    const opened = terminals.find((t) => t.session === "room-design-talk");
    expect(opened?.command).toEqual(["claude"]);
    expect(container.querySelector('[data-testid="room-stage-bar"]')).not.toBeNull();
  });

  test("with sessions the trigger becomes the deck: live badge, cards for this room only", async () => {
    await renderPanel(createDemoGateway());
    const trigger = container.querySelector('[data-testid="deck-trigger"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Terminals");
    expect(container.querySelector('[data-testid="deck-count"]')?.textContent).toBe("2");

    await openDeck();
    expect(document.querySelector('[data-testid="deck-card-room-design-talk"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="deck-card-room-design-talk.2"]')).not.toBeNull();
    const corpse = document.querySelector('[data-testid="deck-card-resume-demo-run-7"]');
    expect(corpse?.className).toContain("is-ended");
    expect(corpse?.textContent).toContain("yielded to dispatch demo-run-8 of spec mast-kanban-board");
    expect(
      document.querySelector('[data-testid="deck-card-mast-node"]'),
      "sessions bound to no room stay in the Terminal view",
    ).toBeNull();
    const writerCard = document.querySelector('[data-testid="deck-card-room-design-talk"]');
    expect(writerCard?.textContent).toContain("U");
    expect(writerCard?.textContent).toContain("+1");
  });

  test("a session another client opens appears when its pty event lands", async () => {
    const base = createDemoGateway();
    const sessions: DeckSession[] = [];
    const gateway: Gateway = {
      ...base,
      listSessions: async () => ({ ok: true, value: [...sessions] }),
    };
    await renderPanel(gateway);
    expect(container.querySelector('[data-testid="deck-count"]')).toBeNull();

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
    expect(
      container.querySelector('[data-testid="deck-count"]')?.textContent,
      "the deck refreshes on the room's pty events",
    ).toBe("1");
  });

  test("picking a card takes the stage: full view, slim bar, conversation kept mounted", async () => {
    terminals.length = 0;
    await renderPanel(createDemoGateway(), true);
    await pickCard("room-design-talk");

    expect(container.querySelector('[data-testid="fake-terminal-room-design-talk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="room-header"]'), "the stage replaces the header").toBeNull();
    const bar = container.querySelector('[data-testid="room-stage-bar"]');
    expect(bar?.textContent).toContain("Design talk");
    expect(
      container.querySelector('[data-testid="conversation"]'),
      "the conversation stays mounted underneath",
    ).not.toBeNull();

    // The bar's deck control switches sessions without leaving the stage.
    await pickCard("room-design-talk.2");
    expect(container.querySelector('[data-testid="fake-terminal-room-design-talk.2"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="fake-terminal-room-design-talk"]'),
      "the first terminal stays mounted — the keep-mounted law",
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="room-stage-bar"]')).not.toBeNull();

    // Back returns to the conversation and restores the header.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-back"]')?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="room-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="room-stage-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="fake-terminal-room-design-talk.2"]')).not.toBeNull();
  });

  test("room messages while attached badge the back affordance; back clears it", async () => {
    const gateway = createDemoGateway();
    await renderPanel(gateway, true);
    await pickCard("room-design-talk");
    expect(container.querySelector('[data-testid="stage-unread"]')).toBeNull();

    await act(async () => {
      gateway.emit(ptyEvent({ type: "spec_message_posted", data: { message_id: "m1" } }));
      gateway.emit(ptyEvent({ type: "spec_message_posted", data: { message_id: "m2" } }));
    });
    await flush();
    expect(container.querySelector('[data-testid="stage-unread"]')?.textContent).toBe("2");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-back"]')?.click();
    });
    await flush();
    await pickCard("room-design-talk");
    expect(container.querySelector('[data-testid="stage-unread"]')).toBeNull();
  });

  test("⌘⇧L toggles the stage: back to the conversation, then back to the session", async () => {
    await renderPanel(createDemoGateway(), true);
    await pickCard("room-design-talk");
    expect(container.querySelector('[data-testid="room-stage-bar"]')).not.toBeNull();

    const chord = () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }),
      );
    await act(async () => {
      chord();
    });
    await flush();
    expect(container.querySelector('[data-testid="room-header"]')).not.toBeNull();
    await act(async () => {
      chord();
    });
    await flush();
    expect(container.querySelector('[data-testid="room-stage-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="fake-terminal-room-design-talk"]')).not.toBeNull();
  });

  test("an inactive (hidden) panel ignores the stage chord", async () => {
    await renderPanel(createDemoGateway(), true, false);
    await pickCard("room-design-talk");
    expect(container.querySelector('[data-testid="room-stage-bar"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }),
      );
    });
    await flush();
    expect(
      container.querySelector('[data-testid="room-stage-bar"]'),
      "a keep-mounted hidden room must not react to the global chord",
    ).not.toBeNull();
  });

  test("a yielded resume corpse shows the reason and withholds Reopen while the dispatch runs", async () => {
    // The demo yield names mast-kanban-board, whose demo build run is running.
    await renderPanel(createDemoGateway(), true);
    await pickCard("resume-demo-run-7");
    const card = container.querySelector('[data-testid="deck-ended-card"]');
    expect(card?.textContent).toContain("yielded to dispatch demo-run-8 of spec mast-kanban-board");
    expect(card?.textContent).toContain("A dispatch is live");
    expect(card?.textContent).not.toContain("Reopen");
    expect(container.querySelector('[data-testid="room-stage-bar"]'), "the way back stays visible").not.toBeNull();
  });

  test("a yielded corpse reopens once no dispatch is live on its spec", async () => {
    const base = createDemoGateway();
    const gateway: Gateway = {
      ...base,
      listRuns: async (specId) => ({ ok: true, value: { spec: specId, runs: [] } }),
    };
    terminals.length = 0;
    await renderPanel(gateway, true);
    await pickCard("resume-demo-run-7");
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
    await pickCard("resume-demo-run-7");
    const card = container.querySelector('[data-testid="deck-ended-card"]');
    expect(card?.textContent).not.toContain("Reopen");
  });

  test("the deck's new-terminal rows mint a room-bound session and attach in place", async () => {
    terminals.length = 0;
    await renderPanel(createDemoGateway(), true);
    await openDeck();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="deck-new-claude"]')?.click();
    });
    await flush();
    // room-design-talk and .2 exist on the host, so the fresh one takes .3.
    const opened = terminals.find((t) => t.session === "room-design-talk.3");
    expect(opened).toBeDefined();
    expect(opened?.command).toEqual(["claude"]);
    expect(opened?.room).toBe("design-talk");
    expect(opened?.project).toBe("sail-mast");
    expect(container.querySelector('[data-testid="fake-terminal-room-design-talk.3"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="room-stage-bar"]'),
      "a fresh terminal takes the stage immediately",
    ).not.toBeNull();
  });

  test("a card's close verb parks on the kill confirm", async () => {
    await renderPanel(createDemoGateway(), true);
    await openDeck();
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Close session room-design-talk"]')
        ?.click();
    });
    await flush();
    expect(document.body.textContent).toContain("Close session room-design-talk?");
  });

  test("without the Tauri edge a live card explains where attaching lives", async () => {
    await renderPanel(createDemoGateway());
    await pickCard("room-design-talk");
    expect(container.querySelector('[data-testid="deck-attach-unavailable"]')).not.toBeNull();
  });

  test("a handshake skew becomes the popover card naming the older side", async () => {
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
    await openDeck();
    const pop = document.querySelector('[data-testid="deck-pop"]');
    expect(pop?.textContent).toContain("This box's sail is older than Mast");
    expect(pop?.textContent).toContain("sail upgrade");
    expect(document.querySelector('[data-testid^="deck-card-"]')).toBeNull();
  });
});
