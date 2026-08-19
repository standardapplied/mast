import { describe, expect, test } from "bun:test";
import type { RunListResponse, RunView, SailEvent } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { connectPresence, PRESENCE_THRESHOLD_MS, PresenceStore } from "./presenceStore";

const T0 = Date.parse("2026-08-13T12:00:00Z");

function run(partial: Partial<RunView> & Pick<RunView, "id" | "spec_id" | "status">): RunView {
  return {
    project: "chorus",
    node: "demo",
    role: "build",
    agent: "claude-code",
    started_at: "2026-08-13T11:00:00Z",
    ...partial,
  } as RunView;
}

function event(partial: Partial<SailEvent> & Pick<SailEvent, "type">): SailEvent {
  return {
    v: 1,
    ts: new Date(T0).toISOString(),
    project: "chorus",
    spec: "spec-a",
    agent: "claude-code",
    host: "demo",
    ...partial,
  };
}

describe("load derivation", () => {
  test("a running run with a fresh stamp reads working", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "r1",
        spec_id: "spec-a",
        status: "running",
        last_activity_at: new Date(T0 - 10_000).toISOString(),
      }),
    ]);
    expect(store.presenceOf("spec-a", T0)?.state).toBe("working");
  });

  test("a stale stamp reads quiet against the local clock", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "r1",
        spec_id: "spec-a",
        status: "running",
        last_activity_at: new Date(T0 - PRESENCE_THRESHOLD_MS - 60_000).toISOString(),
      }),
    ]);
    const presence = store.presenceOf("spec-a", T0);
    expect(presence?.state).toBe("quiet");
    expect(presence?.lastActivityAt).toBe(T0 - PRESENCE_THRESHOLD_MS - 60_000);
  });

  test("the server's quiet verdict overrides a skewed local clock", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "r1",
        spec_id: "spec-a",
        status: "running",
        last_activity_at: new Date(T0 - 5_000).toISOString(),
        presence: "quiet",
      }),
    ]);
    expect(store.presenceOf("spec-a", T0)?.state).toBe("quiet");
  });

  test("a running run without a stamp has no presence — never guess", () => {
    const store = new PresenceStore();
    store.noteRuns([run({ id: "r1", spec_id: "spec-a", status: "running" })]);
    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });

  test("a terminal run seeds nothing while a running sibling keeps its own presence", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "r1",
        spec_id: "spec-a",
        status: "running",
        last_activity_at: new Date(T0).toISOString(),
      }),
    ]);
    store.noteRuns([
      run({
        id: "r2",
        spec_id: "spec-a",
        status: "completed",
        started_at: "2026-08-13T11:30:00Z",
      }),
      run({
        id: "r1",
        spec_id: "spec-a",
        status: "running",
        started_at: "2026-08-13T11:00:00Z",
        last_activity_at: new Date(T0).toISOString(),
      }),
    ]);
    expect(store.presenceOf("spec-a", T0)?.state).toBe("working");
  });

  test("runs without a spec are ignored", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({ id: "r1", spec_id: undefined, status: "running", last_activity_at: "x" }),
    ]);
    expect(store.version).toBe(0);
  });

  test("a running run with no presence signal leaves no lingering entry", () => {
    // A run with no stamp yet — brand-new, or a pre-upgrade row — has no presence.
    // It must not seed an entry that no later event would clear. (Review/fix runs
    // do stamp once they emit progress; this is the stampless case, any role.)
    const store = new PresenceStore();
    store.noteRuns([run({ id: "r1", spec_id: "spec-a", status: "running", role: "review" })]);
    expect(store.presenceOf("spec-a", T0)).toBeNull();
    expect(store.version).toBe(0);
  });

  test("a snapshot is authoritative: entries for runs it no longer lists are gone", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({ id: "r1", spec_id: "spec-a", status: "running", last_activity_at: new Date(T0).toISOString() }),
    ]);
    expect(store.presenceOf("spec-a", T0)?.state).toBe("working");
    store.noteRuns([
      run({
        id: "r2",
        spec_id: "spec-a",
        status: "running",
        role: "review",
        started_at: "2026-08-13T11:30:00Z",
      }),
    ]);
    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });
});

describe("two concurrent runs", () => {
  test("a build and a chat turn are tracked independently and one exit never wipes the other", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "build-1",
        spec_id: "spec-a",
        status: "running",
        role: "build",
        last_activity_at: new Date(T0).toISOString(),
      }),
      run({
        id: "chat-1",
        spec_id: "spec-a",
        status: "running",
        role: "room",
        started_at: "2026-08-13T11:31:00Z",
        last_activity_at: new Date(T0).toISOString(),
      }),
    ]);
    expect(store.presenceOf("spec-a", T0)?.role).toBe("build");
    expect(store.chatPresenceOf("spec-a", T0)?.role).toBe("room");

    store.noteEvent(
      event({ type: "agent_session_stopped", data: { run_id: "chat-1", run_role: "room" } }),
    );
    expect(store.chatPresenceOf("spec-a", T0)).toBeNull();
    expect(store.presenceOf("spec-a", T0)?.role).toBe("build");

    store.noteEvent(event({ type: "agent_session_completed", data: { run_id: "build-1" } }));
    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });

  test("a run-id-less terminal event keeps the legacy clear-the-spec behavior", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "build-1",
        spec_id: "spec-a",
        status: "running",
        last_activity_at: new Date(T0).toISOString(),
      }),
    ]);
    store.noteEvent(event({ type: "agent_session_stopped" }));
    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });

  test("chatPresenceOf sees room-full turns and ignores working lanes", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "chat-2",
        spec_id: "spec-a",
        status: "running",
        role: "room-full",
        last_activity_at: new Date(T0).toISOString(),
      }),
    ]);
    expect(store.chatPresenceOf("spec-a", T0)?.state).toBe("working");
    expect(store.presenceOf("spec-a", T0)?.role).toBe("room-full");
    expect(store.chatPresenceOf("spec-b", T0)).toBeNull();
  });
});

describe("SSE updates", () => {
  test("a progress event creates a working entry with no role claim", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "agent_tool_started" }));
    const presence = store.presenceOf("spec-a", T0);
    expect(presence?.state).toBe("working");
    expect(presence?.role).toBeUndefined();
  });

  test("progress bursts inside the freshness window do not notify", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "agent_tool_started" }));
    const after = store.version;
    for (let i = 0; i < 50; i++) {
      store.noteEvent(
        event({ type: "agent_log_chunk", ts: new Date(T0 + 1_000 + i).toISOString() }),
      );
    }
    expect(store.version).toBe(after);
    expect(store.presenceOf("spec-a", T0 + 2_000)?.state).toBe("working");
  });

  test("an agent_presence quiet event flips the chip and carries the stamp", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "agent_tool_started" }));
    store.noteEvent(
      event({
        type: "agent_presence",
        data: {
          presence: "quiet",
          run_role: "build",
          last_activity_at: new Date(T0 - 180_000).toISOString(),
        },
      }),
    );
    const presence = store.presenceOf("spec-a", T0);
    expect(presence?.state).toBe("quiet");
    expect(presence?.lastActivityAt).toBe(T0 - 180_000);
  });

  test("resumed activity clears a quiet verdict", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "agent_presence", data: { presence: "quiet" } }));
    store.noteEvent(event({ type: "agent_tool_finished" }));
    expect(store.presenceOf("spec-a", T0)?.state).toBe("working");
  });

  test("a terminal event drops presence entirely", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "agent_tool_started" }));
    store.noteEvent(event({ type: "agent_session_stopped" }));
    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });

  test("unknown event types and spec-less events are ignored", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "board_updated" }));
    store.noteEvent(event({ type: "agent_tool_started", spec: undefined }));
    expect(store.version).toBe(0);
  });
});

describe("role labeling", () => {
  test("the run row's role survives into presence", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({
        id: "r1",
        spec_id: "spec-a",
        status: "running",
        role: "review",
        last_activity_at: new Date(T0).toISOString(),
      }),
    ]);
    expect(store.presenceOf("spec-a", T0)?.role).toBe("review");
  });

  test("an agent_presence event's run_role updates the label", () => {
    const store = new PresenceStore();
    store.noteEvent(
      event({ type: "agent_presence", data: { presence: "working", run_role: "review" } }),
    );
    expect(store.presenceOf("spec-a", T0)?.role).toBe("review");
  });
});

describe("connect ordering", () => {
  test("a terminal event racing the initial snapshot is not clobbered by stale rows", async () => {
    const store = new PresenceStore();
    let resolveRuns!: (r: SailResult<RunListResponse>) => void;
    const runs = new Promise<SailResult<RunListResponse>>((resolve) => {
      resolveRuns = resolve;
    });
    let emit: (event: SailEvent) => void = () => {};
    const gateway = {
      listRuns: () => runs,
      onEvent: (listener: (event: SailEvent) => void) => {
        emit = listener;
        return () => {};
      },
    };

    connectPresence(gateway, store);
    // The run goes terminal while the snapshot — read a moment earlier, still
    // showing it running with a fresh stamp — is in flight.
    emit(event({ type: "agent_session_stopped", spec: "spec-a" }));
    resolveRuns({
      ok: true,
      value: {
        spec: "",
        runs: [
          run({
            id: "r1",
            spec_id: "spec-a",
            status: "running",
            last_activity_at: new Date(T0).toISOString(),
          }),
        ],
      },
    });
    await runs;
    await Promise.resolve();

    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });
});

describe("null fallback", () => {
  test("an unknown spec has no presence", () => {
    expect(new PresenceStore().presenceOf("nope", T0)).toBeNull();
  });

  test("a quiet verdict with no stamp still reads quiet without an elapsed anchor", () => {
    const store = new PresenceStore();
    store.noteEvent(event({ type: "agent_presence", data: { presence: "quiet" } }));
    const presence = store.presenceOf("spec-a", T0);
    expect(presence?.state).toBe("quiet");
    expect(presence?.lastActivityAt).toBeNull();
  });

  test("subscribers hear changes and can unsubscribe", () => {
    const store = new PresenceStore();
    let heard = 0;
    const off = store.subscribe(() => heard++);
    store.noteEvent(event({ type: "agent_tool_started" }));
    expect(heard).toBe(1);
    off();
    store.noteEvent(event({ type: "agent_session_stopped" }));
    expect(heard).toBe(1);
  });
});
