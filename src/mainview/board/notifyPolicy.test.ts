import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import { notification } from "./notifyPolicy";

function event(type: string, overrides: Partial<SailEvent> = {}): SailEvent {
  return {
    v: 1,
    id: 1,
    ts: "2026-08-16T10:00:00Z",
    project: "mast",
    spec: "s1",
    type,
    agent: "claude/run-1",
    host: "devbox",
    ...overrides,
  };
}

describe("notification policy", () => {
  test("an agent question pages needs-reply", () => {
    const decision = notification(
      event("spec_message_posted", { data: { question: true, message_id: "m1" } }),
      null,
    );
    expect(decision?.kind).toBe("needs-reply");
    expect(decision?.tone).toBe("info");
    expect(decision?.specId).toBe("s1");
    expect(decision?.message).toContain("s1");
  });

  test("the focused room is suppressed for questions and run endings alike", () => {
    expect(
      notification(event("spec_message_posted", { data: { question: true } }), "s1"),
    ).toBeNull();
    expect(notification(event("agent_session_completed"), "s1")).toBeNull();
    expect(
      notification(event("spec_message_posted", { data: { question: true } }), "other"),
    ).not.toBeNull();
  });

  test("a human question never pages — needs_reply is an agent flag", () => {
    expect(
      notification(event("spec_message_posted", { agent: "uday", data: { question: true } }), null),
    ).toBeNull();
  });

  test("a plain room message never pages", () => {
    expect(
      notification(event("spec_message_posted", { data: { message_id: "m1" } }), null),
    ).toBeNull();
    expect(
      notification(event("spec_message_posted", { data: { question: "yes" } }), null),
    ).toBeNull();
  });

  test("run completion pages and failure pages as an error", () => {
    const completed = notification(event("agent_session_completed"), null);
    expect(completed?.kind).toBe("run-ended");
    expect(completed?.tone).toBe("info");

    const failed = notification(event("agent_failed"), null);
    expect(failed?.kind).toBe("run-ended");
    expect(failed?.tone).toBe("error");

    expect(notification(event("agent_session_stopped"), null)?.kind).toBe("run-ended");
    expect(notification(event("agent_cancelled"), null)?.kind).toBe("run-ended");
  });

  test("tool events, log chunks, presence, and starts never fire", () => {
    for (const type of [
      "agent_tool_started",
      "agent_tool_finished",
      "agent_log_chunk",
      "agent_presence",
      "heartbeat",
      "agent_session_started",
      "spec_dispatched",
      "spec_status_changed",
      "board_updated",
    ]) {
      expect(notification(event(type), null)).toBeNull();
    }
  });

  test("an event without a spec never fires", () => {
    expect(notification(event("agent_session_completed", { spec: undefined }), null)).toBeNull();
  });
});
