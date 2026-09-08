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
