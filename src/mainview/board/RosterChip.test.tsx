import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunView } from "../../shared/sail-models";
import { PresenceStore } from "./presenceStore";
import { RosterChip } from "./RosterChip";

let root: Root;
let container: HTMLElement;

const NOW = Date.parse("2026-08-18T12:00:00Z");

function chatRun(status: string): RunView {
  return {
    id: "chat-1",
    project: "acme",
    spec_id: "s1",
    node: "n",
    role: "room-full",
    agent: "claude-code",
    status,
    started_at: "2026-08-18T11:59:00Z",
    last_activity_at: new Date(NOW).toISOString(),
  };
}

function mount(engaged: boolean, store: PresenceStore, onDismiss?: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <RosterChip
        specId="s1"
        engagement={
          engaged
            ? { agent: "claude-code", mode: "full", engaged_at: "2026-08-18T11:00:00Z" }
            : undefined
        }
        onDismiss={onDismiss}
        store={store}
        now={() => NOW}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RosterChip", () => {
  test("renders nothing when nobody is engaged", () => {
    mount(false, new PresenceStore());
    expect(container.querySelector('[data-testid="roster-s1"]')).toBeNull();
  });

  test("an engaged agent with no live chat turn is in the room", () => {
    mount(true, new PresenceStore());
    const chip = container.querySelector('[data-testid="roster-s1"]');
    expect(chip?.textContent).toContain("claude-code");
    expect(chip?.textContent).toContain("in the room");
  });

  test("a live chat turn reads as thinking", () => {
    const store = new PresenceStore();
    store.noteRuns([chatRun("running")]);
    mount(true, store);
    expect(container.querySelector('[data-testid="roster-s1"]')?.textContent).toContain(
      "thinking…",
    );
  });

  test("dismiss fires the callback", () => {
    let dismissed = 0;
    mount(true, new PresenceStore(), () => dismissed++);
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="roster-dismiss-s1"]')?.click(),
    );
    expect(dismissed).toBe(1);
  });
});
