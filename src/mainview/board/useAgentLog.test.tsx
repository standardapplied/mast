import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentLogRole, SailEvent } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import type { AgentLogLine, AgentLogState } from "../tauri/agentLogStream";
import { useAgentLog, type AgentLogView } from "./useAgentLog";

let root: Root;
let container: HTMLElement;

type FakeHandle = {
  specId: string;
  role: AgentLogRole;
  since: number;
  stopped: boolean;
  emitLine: (line: AgentLogLine) => void;
  emitState: (state: AgentLogState) => void;
  emitError: (message: string) => void;
  onLine: (l: (line: AgentLogLine) => void) => () => void;
  onState: (l: (state: AgentLogState) => void) => () => void;
  onError: (l: (message: string) => void) => () => void;
  stop: () => void;
};

function makeFake(opts: { snapshotError?: string } = {}) {
  const handles: FakeHandle[] = [];
  const snapshotCalls: Array<{ specId: string; role: AgentLogRole }> = [];
  let eventListener: ((e: SailEvent) => void) | null = null;

  const gateway = {
    agentStatus: async (project: string) => ({
      ok: true as const,
      value: {
        name: project,
        agent_running: true,
        started_at: "2026-07-08T11:00:00Z",
        branch: "agent/chorus-invoice-ui",
      },
    }),
    agentLogSnapshot: async (specId: string, role: AgentLogRole) => {
      snapshotCalls.push({ specId, role });
      return opts.snapshotError
        ? {
            ok: false as const,
            error: { status: 404, code: "run_not_found", message: opts.snapshotError },
          }
        : {
            ok: true as const,
            value: {
              run_id: `run-${role}`,
              lines: [
                `{"type":"assistant","message":{"content":[{"type":"text","text":"snap ${role}"}]}}`,
              ],
            },
          };
    },
    followAgentLog: (specId: string, role: AgentLogRole, since: number) => {
      const lineListeners = new Set<(l: AgentLogLine) => void>();
      const stateListeners = new Set<(s: AgentLogState) => void>();
      const errorListeners = new Set<(m: string) => void>();
      const handle: FakeHandle = {
        specId,
        role,
        since,
        stopped: false,
        emitLine: (line) => lineListeners.forEach((l) => l(line)),
        emitState: (s) => stateListeners.forEach((l) => l(s)),
        emitError: (m) => errorListeners.forEach((l) => l(m)),
        onLine: (l) => {
          lineListeners.add(l);
          return () => lineListeners.delete(l);
        },
        onState: (l) => {
          stateListeners.add(l);
          return () => stateListeners.delete(l);
        },
        onError: (l) => {
          errorListeners.add(l);
          return () => errorListeners.delete(l);
        },
        stop: () => {
          handle.stopped = true;
        },
      };
      handles.push(handle);
      return handle;
    },
    onEvent: (l: (e: SailEvent) => void) => {
      eventListener = l;
      return () => {
        eventListener = null;
      };
    },
  };

  return {
    gateway: gateway as unknown as Gateway,
    handles,
    snapshotCalls,
    emitEvent: (e: SailEvent) => eventListener?.(e),
  };
}

function Harness({
  gateway,
  capture,
}: {
  gateway: Gateway;
  capture: (v: AgentLogView) => void;
}) {
  capture(useAgentLog(gateway, "chorus", "chorus-invoice-ui"));
  return null;
}

async function render(gateway: Gateway) {
  let latest: AgentLogView | null = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness gateway={gateway} capture={(v) => (latest = v)} />));
  await act(async () => {});
  await act(async () => {});
  return () => latest!;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const texts = (view: AgentLogView) => view.lines.map((l) => l.rendered);
const streamLine = (id: number, text: string): AgentLogLine => ({
  id,
  text: `{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}`,
});

describe("useAgentLog", () => {
  test("resolves snapshot and follow by the clicked spec, not the project", async () => {
    const { gateway, handles, snapshotCalls } = makeFake();
    await render(gateway);

    expect(snapshotCalls).toEqual([{ specId: "chorus-invoice-ui", role: "build" }]);
    expect(handles[0]!.specId).toBe("chorus-invoice-ui");
  });

  test("a terminal stream refusal surfaces as the panel error", async () => {
    const { gateway, handles } = makeFake({ snapshotError: "logs elsewhere" });
    const view = await render(gateway);

    await act(async () => {
      handles[0]!.emitError("Run r1 executed on sumesh-box; its logs live there, not on this box.");
      handles[0]!.emitState("disconnected");
    });
    expect(view().error).toBe(
      "Run r1 executed on sumesh-box; its logs live there, not on this box.",
    );
    expect(view().state).toBe("disconnected");
  });

  test("a failed snapshot surfaces its API error until a line arrives", async () => {
    const { gateway, handles } = makeFake({ snapshotError: "No build run for 'chorus' yet." });
    const view = await render(gateway);

    expect(view().error).toBe("No build run for 'chorus' yet.");
    expect(texts(view())).toEqual([]);

    await act(async () => {
      handles[0]!.emitLine(streamLine(1, "live"));
    });
    expect(view().error).toBeNull();
    expect(texts(view())).toEqual(["live"]);
  });

  test("seeds from the snapshot, then the live stream takes over", async () => {
    const { gateway, handles } = makeFake();
    const view = await render(gateway);

    expect(handles[0]!.role).toBe("build");
    expect(handles[0]!.since).toBe(1);
    expect(texts(view())).toEqual(["snap build"]);

    await act(async () => {
      handles[0]!.emitLine(streamLine(5, "live one"));
    });
    // The first authoritative line clears the provisional snapshot.
    expect(texts(view())).toEqual(["live one"]);

    await act(async () => {
      handles[0]!.emitLine(streamLine(6, "live two"));
    });
    expect(texts(view())).toEqual(["live one", "live two"]);
  });

  test("toggling role follows the other log, and toggling back resumes its cursor", async () => {
    const { gateway, handles } = makeFake();
    const view = await render(gateway);

    await act(async () => {
      handles[0]!.emitLine(streamLine(5, "build line"));
    });
    expect(view().role).toBe("build");

    await act(async () => {
      view().setRole("review");
    });
    await act(async () => {});
    expect(handles[0]!.stopped).toBe(true);
    expect(handles[1]!.role).toBe("review");
    expect(handles[1]!.since).toBe(1);
    expect(texts(view())).toEqual(["snap review"]);

    await act(async () => {
      view().setRole("build");
    });
    await act(async () => {});
    // Build resumes from lastId + 1 and restores its own buffer, not a re-snapshot.
    expect(handles[2]!.role).toBe("build");
    expect(handles[2]!.since).toBe(6);
    expect(texts(view())).toEqual(["build line"]);
  });

  test("reflects live stream state and the raw toggle", async () => {
    const { gateway, handles } = makeFake();
    const view = await render(gateway);

    await act(async () => {
      handles[0]!.emitState("connected");
    });
    expect(view().state).toBe("connected");

    await act(async () => {
      view().setRaw(true);
    });
    expect(view().raw).toBe(true);
  });

  test("surfaces agent_failed as a lifecycle badge, cleared by a restart", async () => {
    const { gateway, emitEvent } = makeFake();
    const view = await render(gateway);

    await act(async () => {
      emitEvent({
        v: 1,
        ts: "t",
        project: "chorus",
        type: "agent_failed",
        agent: "sail",
        host: "h",
        data: { detail: "exit 1" },
      });
    });
    expect(view().lifecycle).toEqual({ type: "agent_failed", detail: "exit 1" });

    await act(async () => {
      emitEvent({ v: 1, ts: "t", project: "chorus", type: "agent_session_started", agent: "sail", host: "h" });
    });
    expect(view().lifecycle).toBeNull();
  });
});
