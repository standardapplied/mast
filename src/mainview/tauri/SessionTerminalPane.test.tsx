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
import type { SessionStatus } from "../terminal/connection";
import { sessionStore } from "../terminal/sessionStore";
import { paletteFor } from "../terminal/terminalPalette";
import { TerminalServicesProvider } from "../terminal/terminalServices";
import { SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

/**
 * The pane at its edge: a real VtCore, a scripted channel, a recording renderer. What these guard
 * is the wiring — the handler that must never throw into the channel, the meta lane that must
 * reach the store, the renderer that must be rebuilt without a re-dial — not terminal semantics,
 * which the controller and core tests own.
 */

let container: HTMLDivElement;
let root: Root;
let services: FakeTerminalServices;
let statuses: SessionStatus[];
let restoreLayout: () => void;

beforeEach(() => {
  restoreLayout = layOutElements();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  services = fakeTerminalServices();
  statuses = [];
  sessionStore.connect(emptyBoxGateway(), "devbox");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  sessionStore.reset();
  restoreLayout();
  delete document.documentElement.dataset.theme;
});

const host = () => container.querySelector("[tabindex]") as HTMLElement;
const keyEvent = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
  host().dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
const lastWrite = () => new TextDecoder().decode(services.link.writes.at(-1)?.bytes ?? new Uint8Array());

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};

const frame = (tag: number, ...payload: number[]) => new Uint8Array([tag, ...payload]);
const bytes = (text: string) => frame(0, ...new TextEncoder().encode(text));
const status = () => statuses.at(-1)!;
const card = () => container.querySelector(".term-overlay__card");

/** Renders a pane; the attach runs on from here (see {@link mount} for the settled form). */
type Over = { session?: string; onWriter?: (fde: string) => void; onBell?: () => void };

function render(over: Over = {}) {
  const handle = createRef<TerminalHandle>();
  root.render(
    <TerminalServicesProvider value={services}>
      <SessionTerminalPane
        ref={handle}
        socketPath="~/.sail/pty.sock"
        token=""
        session={over.session ?? "mast-app"}
        create={{ command: ["bash"], cwd: "~", project: "app", cols: 80, rows: 24 }}
        onStatus={(s) => statuses.push(s)}
        onWriter={over.onWriter}
        onBell={over.onBell}
      />
    </TerminalServicesProvider>,
  );
  return handle;
}

/** Where the core put "X" on row 0, read through a renderer rebuild's full repaint. */
async function columnOfX(): Promise<number> {
  await act(async () => {
    services.renderers.at(-1)!.opts.onLost?.("probe");
  });
  await settle();
  const row = services.renderers.at(-1)!.applied[0]?.rows.find((r) => r.y === 0);
  return row?.cells.findIndex((c) => c.text === "X") ?? -1;
}

/** Mounts a pane and drives it through its attach; resolves with the attachment the link took. */
async function mount(over: Over = {}) {
  let handle!: ReturnType<typeof render>;
  await act(async () => {
    handle = render(over);
  });
  let attachment: FakeAttachment | null = null;
  await act(async () => {
    attachment = await services.link.opened();
  });
  await settle();
  expect(status()).toEqual({ kind: "up" });
  return { handle, attachment: attachment! };
}

describe("SessionTerminalPane at the channel edge", () => {
  test("attaches at its fitted size, creating the session it was asked to", async () => {
    const { attachment } = await mount();
    expect(attachment.spec.create).toEqual({
      command: ["bash"],
      cwd: "~",
      project: "app",
      cols: 80,
      rows: 24,
    });
    expect(services.link.resizes).toEqual([{ id: attachment.spec.id, cols: 80, rows: 24 }]);
    expect(services.renderers).toHaveLength(1);
  });

  test("a throw in the data handler parks the pane on its cause and closes the attachment; nothing parks", async () => {
    const { attachment } = await mount();
    const { lanes } = attachment;
    await act(async () => {
      lanes.onData(bytes("hello"));
    });
    expect(status()).toEqual({ kind: "up" });

    // A frame tag this build does not know: decodeDataFrame throws. The handler must return.
    await act(async () => {
      expect(() => lanes.onData(frame(9, 1, 2, 3))).not.toThrow();
    });
    expect(status()).toEqual({
      kind: "failed",
      reason: "protocol skew: session data frame: unknown tag 9",
    });
    expect(services.link.closed).toEqual([attachment.spec.id]);
    expect(card()?.textContent).toContain("Terminal failed");
    expect(card()?.textContent).toContain("protocol skew");
    expect(card()?.querySelector("button")?.textContent).toBe("Retry");

    // Later messages are dropped, never parked: the handler stays total and the status holds.
    await act(async () => {
      expect(() => lanes.onData(bytes("after"))).not.toThrow();
      expect(() => lanes.onData(frame(9))).not.toThrow();
    });
    expect(status().kind).toBe("failed");
    expect(services.link.closed).toHaveLength(1);
  });

  test("Retry after a lane fault re-dials the session", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(frame(9));
    });
    // The session lived on through the fault: the host still lists it, so the re-dial attaches.
    services.link.listing = { hostBootId: "boot-1", sessions: [{ name: "mast-app", live: true }] };
    const redial = services.link.nextOpen();
    await act(async () => {
      (card()!.querySelector("button") as HTMLButtonElement).click();
    });
    let next: FakeAttachment | null = null;
    await act(async () => {
      next = await redial;
    });
    await settle();
    expect(services.link.opens).toHaveLength(2);
    expect(next!.spec.create, "the create was spent on the first attach").toBeNull();
    expect(status()).toEqual({ kind: "up" });
  });

  test("a paste past the host's frame cap leaves the pane whole; chunking is the core's job", async () => {
    const { handle, attachment } = await mount();
    const text = "p".repeat((1 << 20) + 4096);
    await act(async () => {
      handle.current!.paste(text);
    });
    expect(services.link.writes).toHaveLength(1);
    const write = services.link.writes[0]!;
    expect(write.id).toBe(attachment.spec.id);
    expect(write.bytes.length).toBe(text.length);
    expect(new TextDecoder().decode(write.bytes)).toBe(text);
    expect(status()).toEqual({ kind: "up" });
  });

  test("a resize by another writer letterboxes the core to the pty and says so; the token moving frees it", async () => {
    const { attachment } = await mount();
    const { lanes } = attachment;
    const renderer = services.renderers[0]!;
    await act(async () => {
      lanes.onMeta({ kind: "resized", cols: 132, rows: 40 });
    });
    expect(sessionStore.lane("mast-app").ptySize).toEqual({ cols: 132, rows: 40 });
    const chip = container.querySelector('[data-testid="term-pty-size"]');
    expect(chip?.textContent).toBe("sized by the writer to 132×40");
    expect(renderer.resizes.at(-1)).toEqual([132, 40]);
    expect(services.link.resizes, "an imposed size is never announced back").toHaveLength(1);

    // The token moving to another FDE resizes nothing: the pty is still 132×40, and a pane that
    // refit itself now would parse the writer's output at the wrong width until the next resize.
    await act(async () => {
      lanes.onMeta({ kind: "writer_changed", fde: "mady" });
    });
    expect(container.querySelector('[data-testid="term-pty-size"]')?.textContent).toBe(
      "sized by the writer to 132×40",
    );
    expect(renderer.resizes.at(-1), "still the writer's geometry").toEqual([132, 40]);

    const writers: string[] = [];
    await act(async () => {
      lanes.onMeta({ kind: "writer_changed", fde: "uday" });
    });
    expect(container.querySelector('[data-testid="term-pty-size"]')).toBeNull();
    expect(renderer.resizes.at(-1), "the pane's own fit binds again").toEqual([80, 24]);
    expect(writers).toEqual([]);
  });

  test("the writer broadcast reaches the host callback and the store", async () => {
    const writers: string[] = [];
    const { attachment } = await mount({ onWriter: (fde) => writers.push(fde) });
    await act(async () => {
      attachment.lanes.onMeta({ kind: "writer_changed", fde: "mady" });
    });
    expect(writers).toEqual(["mady"]);
  });

  test("paused and continued are a badge, from the store", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onMeta({ kind: "paused" });
    });
    expect(container.querySelector('[data-testid="term-paused"]')?.textContent).toBe("paused");
    await act(async () => {
      attachment.lanes.onMeta({ kind: "continued" });
    });
    expect(container.querySelector('[data-testid="term-paused"]')).toBeNull();
    expect(status()).toEqual({ kind: "up" });
  });

  test("an unknown meta kind is ignored, not mistaken for a known one", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onMeta({ kind: "throttled", cols: 1, rows: 1 });
    });
    expect(sessionStore.lane("mast-app")).toEqual({ ptySize: null, paused: false });
    expect(status()).toEqual({ kind: "up" });
  });

  test("renderer loss rebuilds the renderer in place from the core's grid — no re-dial", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes("still here"));
    });
    const lost = services.renderers[0]!;
    await act(async () => {
      lost.opts.onLost?.("GPU device lost: reset");
    });
    await settle();
    expect(lost.destroyed).toBe(true);
    expect(services.renderers).toHaveLength(2);
    const fresh = services.renderers[1]!;
    expect(fresh.resizes).toEqual([[80, 24]]);
    expect(fresh.applied[0]?.dirty).toBe("full");
    const firstRow = fresh.applied[0]?.rows.find((r) => r.y === 0);
    expect(firstRow?.cells.map((c) => c.text).join("").trimEnd()).toBe("still here");
    expect(services.link.opens, "the session never went anywhere").toHaveLength(1);
    expect(services.link.closed).toEqual([]);
    expect(status()).toEqual({ kind: "up" });
  });

  test("a rebuild that fails parks on the failed card whose Retry rebuilds again, not re-dials", async () => {
    const { attachment } = await mount();
    services.rendererFailure = "no GPU adapter";
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("GPU device lost: reset");
    });
    await settle();
    expect(status()).toEqual({
      kind: "failed",
      reason: "GPU device lost: reset; rebuild failed: no GPU adapter",
    });
    expect(card()?.querySelector("button")?.textContent).toBe("Retry");
    await act(async () => {
      (card()!.querySelector("button") as HTMLButtonElement).click();
    });
    await settle();
    expect(services.renderers).toHaveLength(2);
    expect(services.link.opens).toHaveLength(1);
    expect(status()).toEqual({ kind: "up" });
    expect(attachment.detached).toBe(false);
  });

  test("a resize the core refuses parks this pane, never the app", async () => {
    const { attachment } = await mount();
    await act(async () => {
      expect(() => attachment.lanes.onMeta({ kind: "resized", cols: 65536, rows: 24 })).not.toThrow();
    });
    await settle();
    expect(status().kind).toBe("failed");
    expect(status()).toMatchObject({ reason: expect.stringContaining("65536x24") });
    expect(services.link.closed).toEqual([attachment.spec.id]);
    expect(sessionStore.lane("mast-app").ptySize, "a refused size binds nothing").toBeNull();
    expect(card()?.textContent).toContain("Terminal failed");
  });

  test("output right behind a resize is parsed in the new geometry, not the old one", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onMeta({ kind: "resized", cols: 132, rows: 40 });
      attachment.lanes.onData(bytes("\x1b[1;100HX"));
    });
    expect(await columnOfX()).toBe(99);
    expect(status()).toEqual({ kind: "up" });
  });

  test("a resize behind output leaves that output in the old geometry: one channel, one order", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes("\x1b[1;100HX"));
      attachment.lanes.onMeta({ kind: "resized", cols: 132, rows: 40 });
    });
    expect(await columnOfX()).toBe(79);
    expect(sessionStore.lane("mast-app").ptySize).toEqual({ cols: 132, rows: 40 });
  });

  test("an ending heard during the open stands; the open resolving does not paint up", async () => {
    const release = services.link.holdOpens();
    await act(async () => {
      render();
    });
    let attachment: FakeAttachment | null = null;
    await act(async () => {
      attachment = await services.link.opened();
    });
    await act(async () => {
      attachment!.lanes.onExit({ class: "ended", reason: "exited(0)" });
    });
    const ended = { kind: "ended", reason: "exited(0)", disposition: "close-pane" };
    expect(status()).toEqual(ended as SessionStatus);
    await act(async () => release());
    await settle();
    expect(status()).toEqual(ended as SessionStatus);
    expect(statuses.filter((s) => s.kind === "up")).toHaveLength(0);
  });

  test("a link drop during the open keeps its reattach; the open resolving does not paint up", async () => {
    services.link.listing = { hostBootId: "boot-1", sessions: [{ name: "mast-app", live: true }] };
    const release = services.link.holdOpens();
    await act(async () => {
      render();
    });
    let attachment: FakeAttachment | null = null;
    await act(async () => {
      attachment = await services.link.opened();
    });
    await act(async () => {
      attachment!.lanes.onExit({ class: "transport", reason: "connection reset" });
    });
    await settle();
    expect(status()).toEqual({ kind: "down", reason: "connection reset" });
    await act(async () => release());
    await settle();
    expect(status()).toEqual({ kind: "down", reason: "connection reset" });
    expect(statuses.filter((s) => s.kind === "up")).toHaveLength(0);
  });

  test("facts streamed before the open resolves are this attach's own and survive it", async () => {
    const release = services.link.holdOpens();
    await act(async () => {
      render();
    });
    let attachment: FakeAttachment | null = null;
    await act(async () => {
      attachment = await services.link.opened();
    });
    await act(async () => {
      attachment!.lanes.onMeta({ kind: "resized", cols: 132, rows: 40 });
    });
    await act(async () => release());
    await settle();
    expect(status()).toEqual({ kind: "up" });
    expect(sessionStore.lane("mast-app").ptySize).toEqual({ cols: 132, rows: 40 });
    expect(container.querySelector('[data-testid="term-pty-size"]')?.textContent).toBe(
      "sized by the writer to 132×40",
    );
  });

  test("a lane fault during the open keeps its card; the open resolving does not paint up", async () => {
    const release = services.link.holdOpens();
    await act(async () => {
      render();
    });
    let attachment: FakeAttachment | null = null;
    await act(async () => {
      attachment = await services.link.opened();
    });
    await act(async () => {
      attachment!.lanes.onData(frame(9));
    });
    expect(status().kind).toBe("failed");
    await act(async () => release());
    await settle();
    expect(status()).toEqual({
      kind: "failed",
      reason: "protocol skew: session data frame: unknown tag 9",
    });
    expect(services.link.closed).toEqual([attachment!.spec.id]);
  });

  test("an unmount during the open closes the attachment the host registered afterwards", async () => {
    const release = services.link.holdOpens();
    await act(async () => {
      render();
    });
    let attachment: FakeAttachment | null = null;
    await act(async () => {
      attachment = await services.link.opened();
    });
    act(() => root.unmount());
    const closedBeforeOpen = services.link.closed.length;
    await act(async () => release());
    await settle();
    expect(attachment!.detached).toBe(true);
    expect(services.link.closed.slice(closedBeforeOpen), "closed again once it existed").toEqual([
      attachment!.spec.id,
    ]);
    root = createRoot(container);
  });

  test("a replacement renderer that fails to install parks the pane on a working Retry", async () => {
    const { attachment } = await mount();
    services.rendererResizeFailure = "Array buffer allocation failed";
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("GPU device lost: reset");
    });
    await settle();
    expect(status()).toEqual({ kind: "failed", reason: "Array buffer allocation failed" });
    expect(services.link.closed).toEqual([attachment.spec.id]);
    services.link.listing = { hostBootId: "boot-1", sessions: [{ name: "mast-app", live: true }] };
    const redial = services.link.nextOpen();
    await act(async () => {
      (card()!.querySelector("button") as HTMLButtonElement).click();
    });
    await act(async () => {
      await redial;
    });
    await settle();
    expect(services.link.opens).toHaveLength(2);
    expect(status()).toEqual({ kind: "up" });
  });

  test("a lane fault after a failed renderer rebuild makes Retry re-dial, not rebuild", async () => {
    const { attachment } = await mount();
    services.rendererFailure = "no GPU adapter";
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("GPU device lost: reset");
    });
    await settle();
    await act(async () => {
      attachment.lanes.onData(frame(9));
    });
    expect(status()).toEqual({
      kind: "failed",
      reason: "protocol skew: session data frame: unknown tag 9",
    });
    services.link.listing = { hostBootId: "boot-1", sessions: [{ name: "mast-app", live: true }] };
    const redial = services.link.nextOpen();
    await act(async () => {
      (card()!.querySelector("button") as HTMLButtonElement).click();
    });
    await act(async () => {
      await redial;
    });
    await settle();
    expect(services.link.opens).toHaveLength(2);
    expect(status()).toEqual({ kind: "up" });
  });

  test("a rebuild that settles after the session ended paints nothing over the ended card", async () => {
    for (const failure of [null, "no GPU adapter"]) {
      services = fakeTerminalServices();
      statuses = [];
      const { attachment } = await mount();
      const release = services.holdRenderers();
      await act(async () => {
        services.renderers[0]!.opts.onLost?.("GPU device lost: reset");
      });
      await act(async () => {
        attachment.lanes.onExit({ class: "ended", reason: "exited(0)" });
      });
      expect(status()).toMatchObject({ kind: "ended", reason: "exited(0)" });
      services.rendererFailure = failure;
      await act(async () => release());
      await settle();
      expect(status(), `rebuild ${failure ? "failed" : "succeeded"} after the ending`).toMatchObject({
        kind: "ended",
        reason: "exited(0)",
      });
      if (!failure) expect(services.renderers[1]?.destroyed, "nothing draws for a dead attach").toBe(true);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  test("a lane fault after the ending keeps the ended card", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onExit({ class: "ended", reason: "exited(0)" });
    });
    await act(async () => {
      expect(() => attachment.lanes.onData(frame(9))).not.toThrow();
    });
    expect(status()).toMatchObject({ kind: "ended", reason: "exited(0)" });
    expect(services.link.closed, "the ending needs no close; the unmount's is enough").toEqual([]);
  });

  test("a mid-stream replay re-baselines the terminal: the snapshot replaces what came before", async () => {
    const { attachment } = await mount();
    const { lanes } = attachment;
    await act(async () => {
      lanes.onData(bytes("stale line"));
      lanes.onData(frame(1, 1));
      lanes.onData(bytes("fresh"));
      lanes.onData(frame(2));
    });
    expect(status()).toEqual({ kind: "up" });
    const row = services.renderers[0]!.applied.at(-1)?.rows.find((r) => r.y === 0);
    expect(row?.cells.map((c) => c.text).join("").trimEnd(), "only the snapshot remains").toBe("fresh");
  });

  test("a runaway reason is capped on the card", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onExit({ class: "refused", reason: "x".repeat(2000) });
    });
    const reason = card()?.querySelector(".term-overlay__reason")?.textContent ?? "";
    expect(reason.length).toBe(200);
    expect(reason.endsWith("…")).toBe(true);
  });

  test("a theme flip recolors the live pane: same attachment, same renderer, new colors", async () => {
    // happy-dom has no matchMedia, so the pane starts light; the flip is to dark.
    const { attachment } = await mount();
    const renderer = services.renderers[0]!;
    expect(renderer.opts.bg).toEqual(paletteFor("light").bg);
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      // happy-dom delivers mutation records on a task, not a microtask: yield one.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(services.link.opens, "no re-dial").toEqual([attachment]);
    expect(services.renderers, "no new renderer").toHaveLength(1);
    expect(renderer.colors.at(-1)?.bg).toEqual(paletteFor("dark").bg);
    expect(status()).toEqual({ kind: "up" });
    await act(async () => {
      attachment.lanes.onData(bytes("\x1b[?996n"));
    });
    expect(lastWrite(), "the program now hears a dark scheme").toBe("\x1b[?997;1n");
  });

  test("a bell flashes the pane and reaches the host", async () => {
    let bells = 0;
    const { attachment } = await mount({ onBell: () => bells++ });
    await act(async () => {
      attachment.lanes.onData(bytes("ding\x07"));
    });
    expect(container.querySelector('[data-testid="term-bell"]')).not.toBeNull();
    expect(bells).toBe(1);
  });

  test("key releases reach the pty once the program asks for them; ⌘ chords the pane owns never do", async () => {
    const { attachment } = await mount();
    await act(async () => {
      keyEvent("keydown", { key: "a", code: "KeyA" });
      keyEvent("keyup", { key: "a", code: "KeyA" });
    });
    expect(services.link.writes.map((w) => new TextDecoder().decode(w.bytes))).toEqual(["a"]);
    await act(async () => {
      attachment.lanes.onData(bytes("\x1b[>3u"));
      keyEvent("keyup", { key: "a", code: "KeyA" });
    });
    expect(lastWrite()).toBe("\x1b[97;1:3u");
    const before = services.link.writes.length;
    await act(async () => {
      keyEvent("keydown", { key: "k", code: "KeyK", metaKey: true });
      keyEvent("keyup", { key: "k", code: "KeyK", metaKey: true });
    });
    expect(services.link.writes).toHaveLength(before);
  });

  test("Shift+PageUp pages into history and ⌘K clears it; at a marked prompt ⌘K asks for a repaint", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\r\n")));
      keyEvent("keydown", { key: "PageUp", code: "PageUp", shiftKey: true });
      attachment.lanes.onData(bytes("\r\nmore"));
    });
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("probe");
    });
    await settle();
    expect(services.link.writes, "paging is local").toHaveLength(0);
    const top = services.renderers.at(-1)!.applied[0]?.rows.find((r) => r.y === 0);
    expect(top?.cells.map((c) => c.text).join("").trimEnd(), "one page up").toBe("line 12");
    await act(async () => {
      attachment.lanes.onData(bytes("\r\n\x1b]133;A\x1b\\$ "));
      keyEvent("keydown", { key: "k", code: "KeyK", metaKey: true });
    });
    expect(services.link.writes.map((w) => Array.from(w.bytes))).toEqual([[0x0c]]);
  });

  test("unmount closes the attachment and detaches the lanes", async () => {
    const { attachment } = await mount();
    act(() => root.unmount());
    expect(services.link.closed).toEqual([attachment.spec.id]);
    expect(attachment.detached).toBe(true);
    expect(services.renderers[0]!.destroyed).toBe(true);
    root = createRoot(container);
  });
});
