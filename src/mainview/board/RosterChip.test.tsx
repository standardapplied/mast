import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EngagementView } from "../../shared/sail-models";
import { RosterChip } from "./RosterChip";

let root: Root;
let container: HTMLElement;

const ENGAGED: EngagementView = {
  agent: "claude-code",
  agent_name: "Claude Code",
  mode: "full",
  engaged_at: "2026-08-18T11:00:00Z",
};

function mount(engagement: EngagementView | undefined, onDismiss?: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<RosterChip specId="s1" engagement={engagement} onDismiss={onDismiss} />));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RosterChip", () => {
  test("renders nothing when nobody is engaged", () => {
    mount(undefined);
    expect(container.querySelector('[data-testid="roster-s1"]')).toBeNull();
  });

  test("names the agent by its harness and its access, and never says it is working", () => {
    mount(ENGAGED);
    expect(container.querySelector('[data-testid="roster-s1"]')?.textContent).toBe(
      "Claude Code · full",
    );
  });

  test("an older box that sends no harness name is named by its agent", () => {
    mount({ ...ENGAGED, agent_name: undefined, mode: "read_only" });
    expect(container.querySelector('[data-testid="roster-s1"]')?.textContent).toBe(
      "claude-code · read only",
    );
  });

  test("remove fires the callback", () => {
    let dismissed = 0;
    mount(ENGAGED, () => dismissed++);
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="roster-remove-s1"]')?.click(),
    );
    expect(dismissed).toBe(1);
  });
});
