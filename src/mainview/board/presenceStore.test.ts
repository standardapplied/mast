import { describe, expect, test } from "bun:test";
import type { RunView, SailEvent } from "../../shared/sail-models";
import { PRESENCE_THRESHOLD_MS, PresenceStore } from "./presenceStore";

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

  test("the newest run decides: a terminal newest clears presence", () => {
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
    expect(store.presenceOf("spec-a", T0)).toBeNull();
  });

  test("runs without a spec are ignored", () => {
    const store = new PresenceStore();
    store.noteRuns([
      run({ id: "r1", spec_id: undefined, status: "running", last_activity_at: "x" }),
    ]);
    expect(store.version).toBe(0);
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
