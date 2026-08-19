import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import { PresenceStore } from "./presenceStore";

const T0 = Date.parse("2026-08-19T12:00:00Z");

function started(runId: string, role?: string): SailEvent {
  return {
    v: 1,
    ts: new Date(T0).toISOString(),
    project: "acme",
    spec: "s1",
    type: "agent_session_started",
    agent: "claude-code",
    host: "h",
    data: { run_id: runId, ...(role ? { run_role: role } : {}) },
  };
}

describe("presence lights at launch, not at first tool call", () => {
  test("a chat turn's session start drives the typing signal immediately", () => {
    const store = new PresenceStore();
    store.noteEvent(started("chat-1", "room-full"));

    expect(store.chatPresenceOf("s1", T0)?.state).toBe("working");
    expect(store.presenceOf("s1", T0)?.role).toBe("room-full");
  });

  test("a build's session start lights the working pill", () => {
    const store = new PresenceStore();
    store.noteEvent(started("build-1", "build"));

    expect(store.presenceOf("s1", T0)?.state).toBe("working");
    expect(store.chatPresenceOf("s1", T0)).toBeNull();
  });

  test("a pre-0.28.1 start without a role still lights the headline pill", () => {
    const store = new PresenceStore();
    store.noteEvent(started("run-1"));

    expect(store.presenceOf("s1", T0)?.state).toBe("working");
  });

  test("the started entry clears on its own stop and no other run's", () => {
    const store = new PresenceStore();
    store.noteEvent(started("chat-1", "room"));
    store.noteEvent(started("build-1", "build"));

    store.noteEvent({
      v: 1,
      ts: new Date(T0).toISOString(),
      project: "acme",
      spec: "s1",
      type: "agent_session_stopped",
      agent: "claude-code",
      host: "h",
      data: { run_id: "chat-1", run_role: "room" },
    });

    expect(store.chatPresenceOf("s1", T0)).toBeNull();
    expect(store.presenceOf("s1", T0)?.role).toBe("build");
  });
});
