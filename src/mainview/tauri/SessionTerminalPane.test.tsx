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
import { clipboardPolicy } from "../terminal/clipboardPolicy";
import { sessionStore } from "../terminal/sessionStore";
import { RESIZE_SETTLE_MS } from "../terminal/terminalController";
import { paletteFor } from "../terminal/terminalPalette";
import { TerminalServicesProvider } from "../terminal/terminalServices";
import { NOTICE_MS, SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

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
  clipboardPolicy.reset();
  restoreLayout();
  delete document.documentElement.dataset.theme;
});

/** A pointer event over cell (x, y): the fake renderer's 10×20 cell at the canvas's origin. */
const pointer = (type: string, x: number, y: number, init: MouseEventInit = {}) => {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const target = container.querySelector("canvas")!;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, clientX: x * 10 + 5, clientY: y * 20 + 5, button: 0, ...init }),
  );
};
const notice = () => container.querySelector('[data-testid="term-notice"]')?.textContent ?? null;
const linkTip = () => container.querySelector('[data-testid="term-link-tip"]')?.textContent ?? null;

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
type Over = {
  session?: string;
  visible?: boolean;
  onWriter?: (fde: string) => void;
  onBell?: () => void;
};

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
        visible={over.visible}
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
    expect(services.link.resizes, "nothing is pushed at the pty before the host answers").toEqual([]);
    expect(services.renderers).toHaveLength(1);
  });

  test("the attach answer sizes the replay to the pty; the token coming here refits and tells the pty once", async () => {
    const { attachment } = await mount();
    const { lanes } = attachment;
    const renderer = services.renderers[0]!;
    await act(async () => {
      lanes.onMeta({ kind: "resized", cols: 126, rows: 40 });
    });
    expect(renderer.resizes.at(-1), "the core is the pty's size before a replay byte lands").toEqual([126, 40]);
    await act(async () => {
      lanes.onData(frame(1, 1));
      lanes.onData(bytes("history at 126 columns"));
      lanes.onData(frame(2));
    });
    expect(renderer.resizes.at(-1)).toEqual([126, 40]);
    expect(services.link.resizes, "no resize while the replay lands").toEqual([]);

    await act(async () => {
      lanes.onMeta({ kind: "writer_changed", fde: "uday" });
    });
    expect(renderer.resizes.at(-1), "the token is here: the pane's own fit binds").toEqual([80, 24]);
    expect(container.querySelector('[data-testid="term-pty-size"]')).toBeNull();
    services.timers.advance(RESIZE_SETTLE_MS);
    expect(services.link.resizes).toEqual([{ id: attachment.spec.id, cols: 80, rows: 24 }]);
  });

  test("an attach answer that drains in one tick still hands the pane its own fit", async () => {
    const { attachment } = await mount();
    const { lanes } = attachment;
    const renderer = services.renderers[0]!;
    await act(async () => {
      lanes.onMeta({ kind: "resized", cols: 126, rows: 40 });
      lanes.onData(frame(1, 1));
      lanes.onData(bytes("history at 126 columns"));
      lanes.onData(frame(2));
      lanes.onMeta({ kind: "writer_changed", fde: "uday" });
    });
    expect(renderer.resizes.slice(-2), "the replay landed at the pty's size, then the token freed the fit").toEqual([
      [126, 40],
      [80, 24],
    ]);
    expect(container.querySelector('[data-testid="term-pty-size"]')).toBeNull();
    services.timers.advance(RESIZE_SETTLE_MS);
    expect(services.link.resizes).toEqual([{ id: attachment.spec.id, cols: 80, rows: 24 }]);
  });

  test("a refused keystroke says why the keys do nothing; Take write re-dials with write; the token arriving clears it", async () => {
    const { attachment } = await mount();
    const chip = () => container.querySelector('[data-testid="term-refused"]');
    await act(async () => {
      attachment.lanes.onMeta({ kind: "refused", reason: "You do not hold the write token." });
    });
    expect(chip()?.textContent).toContain("read-only — You do not hold the write token.");
    expect(status(), "a refusal is not a fault: the attachment lives").toEqual({ kind: "up" });

    services.link.listing = { hostBootId: "boot-1", sessions: [{ name: "mast-app", live: true }] };
    const redial = services.link.nextOpen();
    await act(async () => {
      (chip()!.querySelector("button") as HTMLButtonElement).click();
    });
    let next: FakeAttachment | null = null;
    await act(async () => {
      next = await redial;
    });
    await settle();
    expect(next!.spec.write, "the re-dial asks for the token").toBe(true);
    expect(chip(), "a fresh attach starts without the old refusal").toBeNull();

    await act(async () => {
      next!.lanes.onMeta({ kind: "refused", reason: "You do not hold the write token." });
    });
    expect(chip()).not.toBeNull();
    await act(async () => {
      next!.lanes.onMeta({ kind: "writer_changed", fde: "uday" });
    });
    expect(chip(), "the token moved: whatever was refused is history").toBeNull();
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
      lanes.onData(frame(1, 1));
      lanes.onData(frame(2));
      lanes.onMeta({ kind: "resized", cols: 132, rows: 40 });
    });
    expect(sessionStore.lane("mast-app").ptySize).toEqual({ cols: 132, rows: 40 });
    const chip = container.querySelector('[data-testid="term-pty-size"]');
    expect(chip?.textContent).toBe("sized by the writer to 132×40");
    expect(renderer.resizes.at(-1)).toEqual([132, 40]);
    expect(services.link.resizes, "an imposed size is never announced back").toEqual([]);

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

  test("a hidden pane sheds its renderer and keeps its terminal; shown again, it rebuilds and repaints whole", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes("kept"));
    });
    const shed = services.renderers[0]!;
    await act(async () => {
      render({ visible: false });
    });
    expect(shed.destroyed).toBe(true);
    expect(services.renderers, "nothing replaces it while hidden").toHaveLength(1);
    await act(async () => {
      shed.opts.onLost?.("GPU device lost: reset");
      attachment.lanes.onData(bytes(" on"));
    });
    await settle();
    expect(services.renderers, "a loss while hidden builds nothing").toHaveLength(1);
    await act(async () => {
      render({ visible: true });
    });
    await settle();
    expect(services.renderers).toHaveLength(2);
    const fresh = services.renderers[1]!;
    expect(fresh.destroyed).toBe(false);
    expect(fresh.resizes).toEqual([[80, 24]]);
    expect(fresh.applied[0]?.dirty).toBe("full");
    const firstRow = fresh.applied[0]?.rows.find((r) => r.y === 0);
    expect(firstRow?.cells.map((c) => c.text).join("").trimEnd()).toBe("kept on");
    expect(services.link.opens, "the session never went anywhere").toHaveLength(1);
    expect(status()).toEqual({ kind: "up" });
  });

  test("hidden while a lost renderer is being rebuilt, the pane stays dormant and rebuilds once shown", async () => {
    await mount();
    const release = services.holdRenderers();
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("GPU device lost: reset");
    });
    await act(async () => {
      render({ visible: false });
    });
    await act(async () => {
      release();
    });
    await settle();
    expect(services.renderers).toHaveLength(2);
    expect(services.renderers[1]!.destroyed, "built for a pane that hid meanwhile").toBe(true);
    await act(async () => {
      render({ visible: true });
    });
    await settle();
    expect(services.renderers).toHaveLength(3);
    expect(services.renderers[2]!.destroyed).toBe(false);
    expect(services.renderers[2]!.applied[0]?.dirty).toBe("full");
    expect(status()).toEqual({ kind: "up" });
  });

  test("a pane mounted hidden attaches with no renderer to keep", async () => {
    await mount({ visible: false });
    expect(services.renderers).toHaveLength(1);
    expect(services.renderers[0]!.destroyed).toBe(true);
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

  test("a rebuild that settles after the session ended leaves the draw loop suspended", async () => {
    const { attachment } = await mount();
    const release = services.holdRenderers();
    const lost = services.renderers[0]!;
    await act(async () => {
      lost.opts.onLost?.("GPU device lost: reset");
    });
    expect(lost.destroyed).toBe(true);
    const drawn = lost.draws;
    await act(async () => {
      attachment.lanes.onData(bytes("last words"));
      attachment.lanes.onExit({ class: "ended", reason: "exited(0)" });
    });
    await act(async () => release());
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(lost.draws, "nothing draws through the renderer the rebuild destroyed").toBe(drawn);
    expect(status()).toMatchObject({ kind: "ended", reason: "exited(0)" });
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
    // happy-dom's matchMedia never prefers dark, so the pane starts light; the flip is to dark.
    const { attachment } = await mount();
    const renderer = services.renderers[0]!;
    expect(renderer.opts.bg).toEqual(paletteFor("light").bg);
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      // The observer reports on a microtask; one macrotask yield lets it and the state land.
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
    await act(async () => {
      renderer.opts.onLost?.("GPU device lost");
    });
    await settle();
    expect(services.renderers.at(-1)!.opts.bg, "a rebuilt renderer paints in today's colors").toEqual(
      paletteFor("dark").bg,
    );
  });

  test("hovering a link underlines its run and names the URI; leaving the pane clears both", async () => {
    const { attachment } = await mount();
    const renderer = services.renderers.at(-1)!;
    await act(async () => {
      attachment.lanes.onData(bytes("go \x1b]8;;https://a.b/c\x1b\\here\x1b]8;;\x1b\\ now"));
    });
    act(() => pointer("pointermove", 4, 0));
    expect(linkTip()).toBe("https://a.b/c");
    expect(renderer.hovers.at(-1)).toEqual({ uri: "https://a.b/c", y: 0, start: 3, end: 7 });
    expect(host().style.cursor).toBe("pointer");
    act(() => pointer("pointermove", 0, 0));
    expect(linkTip()).toBeNull();
    expect(renderer.hovers.at(-1)).toBeNull();
    act(() => pointer("pointermove", 5, 0));
    expect(linkTip()).toBe("https://a.b/c");
    act(() => pointer("pointerout", 5, 0));
    expect(linkTip()).toBeNull();
    expect(host().style.cursor).toBe("");
  });

  test("a link hovered when the transport drops is gone from the chrome; the next attach starts unhovered", async () => {
    const { handle, attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes("go \x1b]8;;https://a.b/c\x1b\\here\x1b]8;;\x1b\\ now"));
    });
    act(() => pointer("pointermove", 4, 0));
    expect(linkTip()).toBe("https://a.b/c");
    await act(async () => {
      attachment.lanes.onExit({ class: "transport", reason: "connection reset" });
    });
    await settle();
    expect(linkTip(), "an ended card names no link").toBeNull();
    expect(host().style.cursor).toBe("");

    act(() => handle.current!.revive!());
    let next: FakeAttachment | null = null;
    await act(async () => {
      next = await services.link.opened();
    });
    await settle();
    await act(async () => {
      next!.lanes.onData(bytes("fresh shell, no links"));
    });
    act(() => pointer("pointermove", 4, 0));
    expect(linkTip(), "the pointer resting in the same cell is re-asked of the new core").toBeNull();
    expect(services.renderers.at(-1)!.hovers.at(-1) ?? null).toBeNull();
  });

  test("⌘-click opens a link on the Mac; a refused scheme lands in the pane by name and nothing opens", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes("\x1b]8;;https://a.b/c\x1b\\here\x1b]8;;\x1b\\ \x1b]8;;file:///etc/x\x1b\\etc\x1b]8;;\x1b\\"));
    });
    act(() => pointer("pointerdown", 1, 0, { metaKey: true }));
    await settle();
    expect(services.link.openedUrls).toEqual(["https://a.b/c"]);
    expect(services.link.writes, "the click never reached the pty").toEqual([]);
    expect(notice()).toBeNull();

    services.link.openRefusal = "file: links are not opened by Mast";
    act(() => pointer("pointerdown", 6, 0, { metaKey: true }));
    await settle();
    expect(services.link.openedUrls).toEqual(["https://a.b/c"]);
    expect(notice()).toBe("file: links are not opened by Mast");
    act(() => services.timers.advance(NOTICE_MS));
    expect(notice()).toBeNull();

    act(() => pointer("pointerdown", 1, 0));
    expect(services.link.openedUrls, "a plain click is a selection press, not an open").toHaveLength(1);
  });

  test("a shell writing the clipboard is announced; under deny it is refused instead", async () => {
    const { attachment } = await mount();
    const write = () =>
      act(async () => {
        attachment.lanes.onData(bytes(`\x1b]52;c;${btoa("secret")}\x07`));
      });
    await write();
    expect(notice()).toBe("shell wrote to the clipboard");
    act(() => services.timers.advance(NOTICE_MS));
    expect(notice()).toBeNull();

    clipboardPolicy.set("deny");
    await write();
    expect(notice()).toBe("shell clipboard write refused");
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
      keyEvent("keydown", { key: "a", code: "KeyA" });
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

  test("a release is reported for the press the program heard, whatever the modifiers did meanwhile", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onData(bytes("\x1b[>3u"));
    });
    // ⌘ let go before C: the chord was the pane's, so its release is nobody's.
    await act(async () => {
      keyEvent("keydown", { key: "c", code: "KeyC", metaKey: true });
      keyEvent("keyup", { key: "c", code: "KeyC" });
    });
    expect(services.link.writes).toHaveLength(0);
    // ⌘ pressed after A went down: the program heard the press, so it hears the release too.
    await act(async () => {
      keyEvent("keydown", { key: "a", code: "KeyA" });
      keyEvent("keyup", { key: "a", code: "KeyA", metaKey: true });
    });
    const writes = services.link.writes.map((w) => new TextDecoder().decode(w.bytes));
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe("a");
    expect(writes[1]).toMatch(/^\x1b\[97;\d+:3u$/);
    // The release was consumed with its press: a second one is nobody's either.
    await act(async () => {
      keyEvent("keyup", { key: "a", code: "KeyA" });
    });
    expect(services.link.writes).toHaveLength(2);
  });

  test("a theme flip that lands while a renderer is being rebuilt reaches the rebuilt renderer", async () => {
    await mount();
    const release = services.holdRenderers();
    await act(async () => {
      services.renderers[0]!.opts.onLost?.("GPU device lost");
    });
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => release());
    await settle();
    const rebuilt = services.renderers.at(-1)!;
    expect(services.renderers).toHaveLength(2);
    expect(rebuilt.colors.at(-1)?.bg, "the flip is applied after the install").toEqual(paletteFor("dark").bg);
    expect(status()).toEqual({ kind: "up" });
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
