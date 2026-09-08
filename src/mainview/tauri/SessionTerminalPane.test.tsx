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
});

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};

const frame = (tag: number, ...payload: number[]) => new Uint8Array([tag, ...payload]);
const bytes = (text: string) => frame(0, ...new TextEncoder().encode(text));
const status = () => statuses.at(-1)!;
const card = () => container.querySelector(".term-overlay__card");

/** Mounts a pane and drives it through its attach; resolves with the attachment the link took. */
async function mount(over: { session?: string; onWriter?: (fde: string) => void } = {}) {
  const handle = createRef<TerminalHandle>();
  await act(async () => {
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
        />
      </TerminalServicesProvider>,
    );
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

  test("a runaway reason is capped on the card", async () => {
    const { attachment } = await mount();
    await act(async () => {
      attachment.lanes.onExit({ class: "refused", reason: "x".repeat(2000) });
    });
    const reason = card()?.querySelector(".term-overlay__reason")?.textContent ?? "";
    expect(reason.length).toBe(200);
    expect(reason.endsWith("…")).toBe(true);
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
