import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AgentListResponse,
  EngageResponse,
  ProjectResponse,
  SailEvent,
} from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import type { Gateway } from "../gateway";
import { catalogLaneStubs } from "../../../test/catalogStubs";
import { catalogStore } from "./catalogStore";
import { EngageDialog } from "./EngageDialog";

let root: Root;
let container: HTMLElement;

const CODEX_REASON =
  "Codex CLI has no harness-enforced read-only session inside a sail container.";

const AGENTS: SailResult<AgentListResponse> = {
  ok: true,
  value: {
    agents: [
      {
        name: "claude-code",
        display_name: "Claude Code",
        modes: [
          { mode: "read_only", supported: true },
          { mode: "full", supported: true },
        ],
      },
      {
        name: "codex",
        display_name: "Codex CLI",
        modes: [
          { mode: "read_only", supported: false, reason: CODEX_REASON },
          { mode: "full", supported: true },
        ],
      },
    ],
  },
};

const FULL: SailResult<EngageResponse> = {
  ok: true,
  value: { agent: "claude-code", mode: "full" },
};

const FULL_WITH_SNAPSHOT: SailResult<EngageResponse> = {
  ok: true,
  value: { agent: "claude-code", mode: "full", snapshot: "engage-1" },
};

function mount({
  engage = FULL,
  canDispatch = true,
  project,
}: {
  engage?: SailResult<EngageResponse>;
  canDispatch?: boolean;
  project?: () => Promise<SailResult<ProjectResponse>>;
} = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const listeners = new Set<(event: SailEvent) => void>();
  const calls = {
    closed: 0,
    results: [] as Array<{ message: string; ok: boolean }>,
    requests: [] as Array<Record<string, unknown>>,
    emit: (event: SailEvent) => act(() => listeners.forEach((l) => l(event))),
  };
  const gateway = {
    ...catalogLaneStubs(),
    listAgents: async () => AGENTS,
    ...(project ? { project } : {}),
    engage: async (_id: string, request: Record<string, unknown>) => {
      calls.requests.push(request);
      return engage;
    },
    onEvent: (listener: (event: SailEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Gateway;
  act(() =>
    root.render(
      <EngageDialog
        gateway={gateway}
        specId="s1"
        project="chorus"
        canDispatch={canDispatch}
        roleKnown
        onClose={() => calls.closed++}
        onResult={(message, ok) => calls.results.push({ message, ok })}
      />,
    ),
  );
  return calls;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  catalogStore.reset();
});

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const go = () => container.querySelector('[data-testid="engage-go"]') as HTMLButtonElement;
const toggle = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (b) => b.textContent?.trim() === label,
  );

const engagedEvent = (type: string, data: Record<string, unknown>): SailEvent => ({
  v: 1,
  ts: "2026-08-18T00:00:00Z",
  project: "chorus",
  spec: "s1",
  type,
  agent: "sail",
  host: "h",
  data,
});

const snapshotCheckbox = () =>
  container.querySelector<HTMLElement>('[data-testid="engage-snapshot-field"] [role="checkbox"]');

const CODEX_MEMBER: SailResult<ProjectResponse> = {
  ok: true,
  value: {
    name: "chorus",
    container_status: "running",
    member: { agent: "codex", model: "gpt-5-codex", mode: "full" },
  },
};

describe("EngageDialog", () => {
  test("the agent, model and access start on the project's member", async () => {
    const calls = mount({ project: async () => CODEX_MEMBER });
    await settle();
    act(() => go().click());
    await settle();

    expect(calls.requests[0]).toEqual({ agent: "codex", mode: "full", model: "gpt-5-codex" });
  });

  test("a member read after the engineer chose leaves their choice standing", async () => {
    let answer: (result: SailResult<ProjectResponse>) => void = () => {};
    const calls = mount({ project: () => new Promise((resolve) => (answer = resolve)) });
    await settle();
    act(() => toggle("Read only")?.click());
    answer(CODEX_MEMBER);
    await settle();
    act(() => go().click());
    await settle();

    expect(calls.requests[0]).toEqual({ agent: "claude-code", mode: "read_only" });
  });

  test("the snapshot checkbox carries no rollback warning when unticked", async () => {
    mount();
    await settle();

    const field = container.querySelector('[data-testid="engage-snapshot-field"]');
    expect(field?.textContent).toBe("Snapshot the container first");
    act(() => snapshotCheckbox()?.click());
    expect(field?.textContent).toContain("A rollback point before the agent joins.");
  });

  test("full with no snapshot is the default and settles immediately", async () => {
    const calls = mount();
    await settle();
    act(() => go().click());
    await settle();

    expect(calls.requests[0]).toEqual({ agent: "claude-code", mode: "full" });
    expect(calls.closed).toBe(1);
    expect(calls.results[0]?.ok).toBe(true);
    expect(calls.results[0]?.message).toContain("full access");
  });

  test("opting into the snapshot waits for spec_engaged", async () => {
    const calls = mount({ engage: FULL_WITH_SNAPSHOT });
    await settle();
    act(() => snapshotCheckbox()?.click());
    act(() => go().click());
    await settle();

    expect(calls.requests[0]).toEqual({ agent: "claude-code", mode: "full", snapshot: true });
    expect(container.querySelector('[data-testid="engage-snapshotting"]')).not.toBeNull();
    expect(calls.closed).toBe(0);

    calls.emit(engagedEvent("spec_engaged", { agent: "claude-code", mode: "full" }));
    await settle();
    expect(calls.closed).toBe(1);
    expect(calls.results[0]?.message).toContain("joined s1");
  });

  test("a failed engage snapshot renders the error and keeps the dialog open", async () => {
    const calls = mount({ engage: FULL_WITH_SNAPSHOT });
    await settle();
    act(() => snapshotCheckbox()?.click());
    act(() => go().click());
    await settle();

    calls.emit(engagedEvent("spec_engage_failed", { agent: "claude-code", error: "no space" }));
    await settle();
    expect(calls.closed).toBe(0);
    expect(container.querySelector('[data-testid="engage-refusal"]')?.textContent).toContain(
      "no space",
    );
  });

  test("read only settles immediately with no snapshot wait", async () => {
    const calls = mount({
      engage: { ok: true, value: { agent: "claude-code", mode: "read_only" } },
    });
    await settle();
    act(() => toggle("Read only")?.click());
    act(() => go().click());
    await settle();

    expect(calls.requests[0]).toEqual({ agent: "claude-code", mode: "read_only" });
    expect(calls.closed).toBe(1);
    expect(calls.results[0]?.message).toContain("read only");
  });

  test("a server refusal renders verbatim and holds the dialog open", async () => {
    const calls = mount({
      engage: {
        ok: false,
        error: { status: 400, code: "bad_request", message: CODEX_REASON },
      },
    });
    await settle();
    act(() => go().click());
    await settle();

    expect(calls.closed).toBe(0);
    expect(container.querySelector('[data-testid="engage-refusal"]')?.textContent).toContain(
      "read-only session",
    );
  });
});
