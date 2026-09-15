import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  emptyBoxGateway,
  type FakeAttachment,
  type FakeTerminalServices,
  fakeTerminalServices,
  layOutElements,
} from "../../../test/terminalFakes";
import { ToastProvider } from "../components/Toast";
import type { SessionStatus } from "../terminal/connection";
import { attentionStore } from "../terminal/attention";
import { sessionStore } from "../terminal/sessionStore";
import { TerminalServicesProvider } from "../terminal/terminalServices";
import type { TerminalHandle } from "./SessionTerminalPane";
import { TerminalPanes } from "./TerminalPanes";

/**
 * The pane host with real panes underneath, over the scripted channel: what a lane fault in one
 * pane does to the tab's status, what the host's handle routes where, and that a session's lane
 * facts render in the pane the host mounted for it.
 */

let container: HTMLDivElement;
let root: Root;
let services: FakeTerminalServices;
let reports: Array<SessionStatus | null>;
let restoreLayout: () => void;

beforeEach(() => {
  restoreLayout = layOutElements();
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  services = fakeTerminalServices();
  reports = [];
  sessionStore.connect(emptyBoxGateway(), "devbox");
  attentionStore.connect(localStorage, (r) => services.link.attention(r));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  sessionStore.reset();
  attentionStore.reset();
  restoreLayout();
});

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};

const bytes = (text: string) => new Uint8Array([0, ...new TextEncoder().encode(text)]);
const chips = () => [...container.querySelectorAll(".term-pane-chip")];
const chipTitle = (i: number) => chips()[i]?.querySelector(".term-pane-chip__title")?.textContent ?? null;
const chipCount = (i: number) =>
  chips()[i]?.querySelector('[data-testid="term-pane-chip-count"]')?.textContent ?? null;
const activeChip = () => chips().findIndex((c) => c.classList.contains("is-active"));
const confirmTitle = () => container.querySelector(".dialog-title")?.textContent ?? null;
const edit = () => container.querySelector<HTMLInputElement>('[data-testid="term-pane-chip-edit"]');
const storedLabel = (session: string) =>
  (JSON.parse(localStorage.getItem("mast.panes.mast-app")!) as { meta?: Record<string, { label?: string }> })
    .meta?.[session]?.label;
const button = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
/** A keydown on whatever holds the keyboard — the pane the bar focused, or the chip edit. */
const press = (init: KeyboardEventInit) =>
  act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
const type = (text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(edit()!, text);
    edit()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
const dblclick = (i: number) =>
  act(async () => chips()[i]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
const pointerDownIn = (cell: number) =>
  act(async () => {
    const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    container.querySelectorAll(".term-panes__cell")[cell]!.dispatchEvent(new Ctor("pointerdown", { bubbles: true }));
  });
const title = (a: FakeAttachment, name: string) =>
  act(async () => a.lanes.onData(bytes(`\x1b]0;u@h: /srv/${name}\x07`)));
const bell = (a: FakeAttachment) => act(async () => a.lanes.onData(new Uint8Array([0, 0x07])));
/** ＋ or Split, awaiting the shell it opens. */
async function open(label: string): Promise<FakeAttachment> {
  const next = services.link.nextOpen();
  await act(async () => button(label).click());
  let attachment!: FakeAttachment;
  await act(async () => {
    attachment = await next;
  });
  await settle();
  return attachment;
}
const newShell = () => open("New shell — ⌘T");
const splitRight = () => open("Split right — ⌘D");

async function mount() {
  const handle = createRef<TerminalHandle>();
  await act(async () => {
    root.render(
      <ToastProvider>
        <TerminalServicesProvider value={services}>
          <TerminalPanes ref={handle} target="app" active onStatus={(s) => reports.push(s)} />
        </TerminalServicesProvider>
      </ToastProvider>,
    );
  });
  let attachment: FakeAttachment | null = null;
  await act(async () => {
    attachment = await services.link.opened();
  });
  await settle();
  expect(reports.at(-1)).toEqual({ kind: "up" });
  return { handle, attachment: attachment! };
}

describe("TerminalPanes over the channel", () => {
  test("opening a project tab launches one shell, created through the link", async () => {
    const { attachment } = await mount();
    expect(attachment.spec.session).toBe("mast-app");
    expect(attachment.spec.create?.command).toBeDefined();
    expect(container.querySelectorAll(".term-pane-chip")).toHaveLength(1);
  });

  test("a lane fault in a pane surfaces as the tab's status and the pane's card", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(new Uint8Array([9]));
    });
    expect(reports.at(-1)).toEqual({
      kind: "failed",
      reason: "protocol skew: session data frame: unknown tag 9",
    });
    expect(container.querySelector(".term-overlay__card")?.textContent).toContain("Terminal failed");
    expect(container.querySelector(".term-status__dot--warn")).not.toBeNull();
    expect(services.link.closed).toEqual([attachment.spec.id]);
  });

  test("the host's paste lands in the focused pane as one write", async () => {
    const { handle, attachment } = await mount();
    const text = `${"q".repeat((1 << 20) + 1)}\n`;
    await act(async () => {
      handle.current!.paste(text);
    });
    expect(services.link.writes).toHaveLength(1);
    expect(services.link.writes[0]!.id).toBe(attachment.spec.id);
    expect(services.link.writes[0]!.bytes.length).toBe(text.length);
  });

  test("another writer's resize shows in the pane the host mounted for that session", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onMeta({ kind: "resized", cols: 100, rows: 30 });
    });
    expect(container.querySelector('[data-testid="term-pty-size"]')?.textContent).toBe(
      "sized by the writer to 100×30",
    );
    expect(services.renderers[0]!.resizes.at(-1)).toEqual([100, 30]);
  });

  test("a bell in an unfocused pane dots its chip until that pane is focused again", async () => {
    const { attachment: first } = await mount();
    const bell = (a: FakeAttachment) => act(async () => a.lanes.onData(new Uint8Array([0, 0x07])));
    await bell(first);
    expect(container.querySelector('[data-testid="term-bell-dot"]'), "the focused pane rang").toBeNull();

    const second = services.link.nextOpen();
    await act(async () => {
      (container.querySelector('[aria-label="New shell — ⌘T"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      await second;
    });
    await settle();
    expect(container.querySelectorAll(".term-pane-chip")).toHaveLength(2);
    await bell(first);
    const chips = container.querySelectorAll(".term-pane-chip");
    expect(chips[0]!.querySelector('[data-testid="term-bell-dot"]')).not.toBeNull();
    expect(chips[1]!.querySelector('[data-testid="term-bell-dot"]')).toBeNull();

    await act(async () => {
      (chips[0] as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="term-bell-dot"]')).toBeNull();
  });

  test("a bell's dot and badge are the store's; leaving the surface forgets them", async () => {
    const { attachment: first } = await mount();
    const second = services.link.nextOpen();
    await act(async () => {
      (container.querySelector('[aria-label="New shell — ⌘T"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      await second;
    });
    await settle();
    await act(async () => first.lanes.onData(new Uint8Array([0, 0x07])));
    expect([...attentionStore.unseen()]).toEqual(["mast-app"]);
    expect(services.link.attentions.at(-1)).toEqual({ sound: true, bounce: true, badge: 1 });
    act(() => root.unmount());
    root = createRoot(container);
    expect(attentionStore.unseen().size).toBe(0);
    expect(services.link.attentions.at(-1)).toEqual({ sound: false, bounce: false, badge: null });
  });

  test("a pane the room's listing pruned takes its unseen bell and badge with it", async () => {
    const gateway = {
      ...emptyBoxGateway(),
      killSession: async () => ({ ok: true, value: {} }),
    } as unknown as Parameters<typeof sessionStore.connect>[0];
    sessionStore.reset();
    sessionStore.connect(gateway, "devbox");
    services.link.listing = { hostBootId: "boot-1", sessions: [{ name: "room-r1", live: true }] };
    const entry = {
      name: "room-r1",
      instanceId: "i1",
      live: true,
      attached: 0,
      writerFde: "",
      room: "r1",
      command: ["bash"],
    };
    const renderRoom = (sessions: (typeof entry)[]) =>
      root.render(
        <ToastProvider>
          <TerminalServicesProvider value={services}>
            <TerminalPanes
              room={{ roomId: "r1", project: "app", sessions, dispatchLive: {}, refresh: () => {} }}
              active
              onStatus={(s) => reports.push(s)}
            />
          </TerminalServicesProvider>
        </ToastProvider>,
      );
    await act(async () => renderRoom([entry]));
    let attachment: FakeAttachment | null = null;
    await act(async () => {
      attachment = await services.link.opened();
    });
    await settle();
    expect(reports.at(-1)).toEqual({ kind: "up" });

    await act(async () => window.dispatchEvent(new Event("blur")));
    await act(async () => attachment!.lanes.onData(new Uint8Array([0, 0x07])));
    expect([...attentionStore.unseen()]).toEqual(["room-r1"]);
    expect(services.link.attentions.at(-1)?.badge).toBe(1);

    // Closed from another Mast: the store records the closed death and the next listing lacks it.
    await act(async () => {
      await sessionStore.kill("room-r1", { resolvedRoom: "r1" });
    });
    await act(async () => renderRoom([]));
    await settle();
    expect(container.querySelector('[data-testid="term-panes-empty"]'), "the pane was pruned").not.toBeNull();
    expect(attentionStore.unseen().size, "its bell went with it").toBe(0);
    expect(services.link.attentions.at(-1)).toEqual({ sound: false, bounce: false, badge: null });
  });

  test("renderer loss in a pane is invisible to the tab: it rebuilds without a status change", async () => {
    await mount();
    const before = reports.length;
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("GPU device lost");
    });
    await settle();
    expect(services.renderers).toHaveLength(2);
    expect(services.link.opens).toHaveLength(1);
    expect(reports.length).toBe(before);
  });
});

describe("the chip names the pane you are in", () => {
  test("a split group's chip shows the focused pane's title and the split count; focus moves it", async () => {
    const { attachment: api } = await mount();
    await title(api, "api");
    expect(chipTitle(0)).toBe("api");
    expect(chipCount(0)).toBeNull();
    const web = await splitRight();
    await title(web, "web");
    expect(chipTitle(0), "the new split took focus").toBe("web");
    expect(chipCount(0)).toBe("2");
    expect(chips()[0]!.getAttribute("title")).toBe("api · web");
    expect(button("Close shell api · web")).not.toBeNull();
    await pointerDownIn(0);
    expect(chipTitle(0)).toBe("api");
    expect(chips()).toHaveLength(1);
  });

  test("double-click renames the shown pane in place: Enter persists, Escape keeps, empty clears", async () => {
    const { attachment } = await mount();
    await title(attachment, "api");
    await dblclick(0);
    expect(edit()!.placeholder).toBe("api");
    expect(document.activeElement).toBe(edit());
    await type("agent");
    await press({ key: "a", code: "KeyA" });
    await press({ key: "w", code: "KeyW", metaKey: true });
    expect(services.link.writes, "a keystroke in the edit is nobody else's").toHaveLength(0);
    expect(confirmTitle(), "nor is ⌘W").toBeNull();
    await press({ key: "Enter", code: "Enter" });
    expect(edit()).toBeNull();
    expect(chipTitle(0)).toBe("agent");
    expect(storedLabel("mast-app")).toBe("agent");
    expect(document.activeElement?.getAttribute("tabindex"), "the keyboard went back to the pane").toBe("0");

    await dblclick(0);
    expect(edit()!.value).toBe("agent");
    await type("other");
    await press({ key: "Escape", code: "Escape" });
    expect(chipTitle(0)).toBe("agent");
    expect(storedLabel("mast-app")).toBe("agent");

    await dblclick(0);
    await type("");
    await press({ key: "Enter", code: "Enter" });
    expect(chipTitle(0)).toBe("api");
    expect(storedLabel("mast-app")).toBeUndefined();
  });
});

describe("the keyboard runs the shell", () => {
  test("⌘n, ⌘⇧[ ], ⌘⌥← → and ⌘W / ⌘⇧W run the bar; plain ⌘→ is nobody's", async () => {
    await mount();
    await newShell();
    const third = await newShell();
    const fourth = await splitRight();
    expect(activeChip()).toBe(2);
    expect(chipTitle(2)).toBe("4");

    await press({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true });
    expect(chipTitle(2), "the chip follows the keyboard").toBe("3");
    await press({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true });
    expect(chipTitle(2), "the edge holds").toBe("3");
    await bell(fourth);
    expect([...attentionStore.unseen()]).toEqual(["mast-app.4"]);
    expect(chips()[2]!.querySelector('[data-testid="term-bell-dot"]')).not.toBeNull();
    await press({ key: "ArrowRight", code: "ArrowRight", metaKey: true, altKey: true });
    expect(chipTitle(2)).toBe("4");
    expect(attentionStore.unseen().size, "focus is seeing the bell").toBe(0);
    expect(chips()[2]!.querySelector('[data-testid="term-bell-dot"]')).toBeNull();

    await press({ key: "2", code: "Digit2", metaKey: true });
    expect(activeChip()).toBe(1);
    await press({ key: "3", code: "Digit3", metaKey: true });
    expect(activeChip()).toBe(2);
    expect(chipTitle(2), "the group's remembered pane has the keyboard").toBe("4");
    await press({ key: "8", code: "Digit8", metaKey: true });
    expect(activeChip(), "no eighth group").toBe(2);
    await press({ key: "1", code: "Digit1", metaKey: true });
    expect(activeChip()).toBe(0);
    await press({ key: "9", code: "Digit9", metaKey: true });
    expect(activeChip(), "⌘9 is the last").toBe(2);
    await press({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
    expect(activeChip(), "wraps forward").toBe(0);
    await press({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(activeChip(), "wraps back").toBe(2);

    const before = services.link.writes.length;
    await press({ key: "ArrowRight", code: "ArrowRight", metaKey: true });
    expect(services.link.writes).toHaveLength(before);
    expect(chipTitle(2)).toBe("4");
    expect(activeChip()).toBe(2);

    await press({ key: "w", code: "KeyW", metaKey: true });
    expect(confirmTitle()).toBe("Close shell 4?");
    await act(async () => (container.querySelector(".dialog-layer .btn-ghost") as HTMLButtonElement).click());
    expect(confirmTitle()).toBeNull();
    await press({ key: "W", code: "KeyW", metaKey: true, shiftKey: true });
    expect(confirmTitle()).toBe("Close 2 shells?");
    expect(services.link.opens, "every pane stayed mounted").toHaveLength(4);
    expect(services.link.closed).toHaveLength(0);
    expect(third.detached).toBe(false);
  });

  test("a program that asked for every key still yields ⌘W to the app", async () => {
    const { attachment } = await mount();
    await act(async () => attachment.lanes.onData(bytes("\x1b[>8u")));
    await press({ key: "j", code: "KeyJ", metaKey: true });
    expect(services.link.writes, "report-all is on: the program hears ⌘J").toHaveLength(1);
    await press({ key: "w", code: "KeyW", metaKey: true });
    expect(services.link.writes).toHaveLength(1);
    expect(confirmTitle()).toBe("Close shell 1?");
  });

  test("with the last shell gone, ⌘T still opens one", async () => {
    sessionStore.reset();
    sessionStore.connect(
      {
        ...emptyBoxGateway(),
        killSession: async () => ({ ok: true, value: {} }),
      } as unknown as Parameters<typeof sessionStore.connect>[0],
      "devbox",
    );
    await mount();
    await press({ key: "w", code: "KeyW", metaKey: true });
    await act(async () => (container.querySelector(".dialog-layer .btn-danger") as HTMLButtonElement).click());
    await settle();
    expect(container.querySelector('[data-testid="term-panes-empty"]')).not.toBeNull();
    expect(chips()).toHaveLength(0);
    const next = services.link.nextOpen();
    await press({ key: "t", code: "KeyT", metaKey: true });
    await act(async () => {
      await next;
    });
    await settle();
    expect(chips()).toHaveLength(1);
  });

  test("a room's panes answer the same chords", async () => {
    const entry = (name: string) => ({
      name,
      instanceId: `i-${name}`,
      live: true,
      attached: 0,
      writerFde: "",
      room: "r1",
      command: ["bash"],
    });
    const sessions = [entry("room-r1"), entry("room-r1.2")];
    services.link.listing = { hostBootId: "boot-1", sessions: sessions.map((s) => ({ name: s.name, live: true })) };
    await act(async () =>
      root.render(
        <ToastProvider>
          <TerminalServicesProvider value={services}>
            <TerminalPanes
              room={{ roomId: "r1", project: "app", sessions, dispatchLive: {}, refresh: () => {} }}
              active
              onStatus={(s) => reports.push(s)}
            />
          </TerminalServicesProvider>
        </ToastProvider>,
      ),
    );
    await act(async () => {
      await services.link.opened();
    });
    await settle();
    expect(chips()).toHaveLength(2);
    expect(activeChip()).toBe(0);
    const second = services.link.nextOpen();
    await press({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
    await act(async () => {
      await second;
    });
    await settle();
    expect(activeChip()).toBe(1);
    await press({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
    expect(activeChip(), "wraps").toBe(0);
    await press({ key: "w", code: "KeyW", metaKey: true });
    expect(confirmTitle()).toBe("Close shell 1?");
  });
});
