import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import { PresenceStore } from "./presenceStore";
import { typingVisible } from "./SpecRoom";

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

describe("typing means composing something you haven't seen yet", () => {
  const T1 = T0 + 5_000;

  test("dots show while the turn runs with no reply yet", () => {
    const store = new PresenceStore();
    store.noteEvent(started("chat-1", "room-full"));
    expect(typingVisible(store.chatPresenceOf("s1", T0), null)).toBe(true);
  });

  test("dots hide the moment the reply lands and stay hidden through the turn's tail", () => {
    const store = new PresenceStore();
    store.noteEvent(started("chat-1", "room-full"));
    const replyAt = T1;
    expect(typingVisible(store.chatPresenceOf("s1", T1), replyAt)).toBe(false);
    store.noteEvent({
      v: 1,
      ts: new Date(T1 + 2_000).toISOString(),
      project: "acme",
      spec: "s1",
      type: "agent_tool_started",
      agent: "claude-code",
      host: "h",
      data: { run_id: "chat-1" },
    });
    expect(
      typingVisible(store.chatPresenceOf("s1", T1 + 2_000), replyAt),
      "teardown activity after the reply must not resurrect the dots",
    ).toBe(false);
  });

  test("a reply from an earlier turn does not suppress the next turn's dots", () => {
    const store = new PresenceStore();
    const oldReplyAt = T0 - 60_000;
    store.noteEvent(started("chat-2", "room"));
    expect(typingVisible(store.chatPresenceOf("s1", T0), oldReplyAt)).toBe(true);
  });

  test("no live chat turn means no dots whatever the messages say", () => {
    expect(typingVisible(null, null)).toBe(false);
    expect(typingVisible(null, T0)).toBe(false);
  });

  test("a start-time-less entry (pre-0.28.1 server) keeps the old always-on behavior", () => {
    expect(typingVisible({ startedAt: null }, T0)).toBe(true);
  });
});

