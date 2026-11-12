import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import { needsBody, notification, type NotifyFacts } from "./notifyPolicy";

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

/** Today's facts for an agent rule: a focused window looking at `focused`. */
function at(focused: string | null, isEngaged?: (specId: string) => boolean): NotifyFacts {
  return { onScreen: (id) => id === focused, windowFocused: true, isEngaged };
}

describe("notification policy", () => {
  test("an agent question pages needs-reply", () => {
    const decision = notification(
      event("spec_message_posted", { data: { question: true, message_id: "m1" } }),
      at(null),
    );
    expect(decision?.kind).toBe("needs-reply");
    expect(decision?.tone).toBe("info");
    expect(decision?.specId).toBe("s1");
    expect(decision?.message).toContain("s1");
  });

  test("the focused room is suppressed for questions and run endings alike", () => {
    expect(
      notification(event("spec_message_posted", { data: { question: true } }), at("s1")),
    ).toBeNull();
    expect(notification(event("agent_session_completed"), at("s1"))).toBeNull();
    expect(
      notification(event("spec_message_posted", { data: { question: true } }), at("other")),
    ).not.toBeNull();
  });

  test("a human question never pages needs-reply — needs_reply is an agent flag", () => {
    const asked = event("spec_message_posted", { agent: "uday", data: { question: true } });
    expect(notification(asked, { ...at(null), me: "ravi" })?.kind).toBe("message");
  });

  test("a plain room message never pages", () => {
    expect(
      notification(event("spec_message_posted", { data: { message_id: "m1" } }), at(null)),
    ).toBeNull();
    expect(
      notification(event("spec_message_posted", { data: { question: "yes" } }), at(null)),
    ).toBeNull();
  });

  test("run completion pages and failure pages as an error", () => {
    const completed = notification(event("agent_session_completed"), at(null));
    expect(completed?.kind).toBe("run-ended");
    expect(completed?.tone).toBe("info");

    const failed = notification(event("agent_failed"), at(null));
    expect(failed?.kind).toBe("run-ended");
    expect(failed?.tone).toBe("error");

    expect(notification(event("agent_session_stopped"), at(null))?.kind).toBe("run-ended");
    expect(notification(event("agent_cancelled"), at(null))?.kind).toBe("run-ended");
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
      expect(notification(event(type), at(null))).toBeNull();
    }
  });

  test("an event without a spec never fires", () => {
    expect(notification(event("agent_session_completed", { spec: undefined }), at(null))).toBeNull();
  });
});

describe("engaged rooms", () => {
  const engaged = (id: string) => id === "chat-room";

  test("an agent's plain reply notifies in an engaged room and nowhere else", () => {
    const reply = {
      v: 1,
      ts: "t",
      project: "acme",
      spec: "chat-room",
      type: "spec_message_posted",
      agent: "claude/room-1",
      host: "h",
      data: {},
    } as SailEvent;
    expect(notification(reply, at(null, engaged))?.kind).toBe("agent-reply");
    expect(notification(reply, at("chat-room", engaged))).toBeNull();
    expect(notification({ ...reply, spec: "other" }, at(null, engaged))).toBeNull();
  });

  test("a clean chat-turn stop is silent; its failure and a build stop are not", () => {
    const stop = (role: string, exit: number) =>
      ({
        v: 1,
        ts: "t",
        project: "acme",
        spec: "chat-room",
        type: "agent_session_stopped",
        agent: "claude-code",
        host: "h",
        data: { run_role: role, exit_code: exit },
      }) as SailEvent;
    expect(notification(stop("room", 0), at(null, engaged))).toBeNull();
    expect(notification(stop("room-full", 0), at(null, engaged))).toBeNull();
    expect(notification(stop("invite-full", 0), at(null, engaged))?.kind).toBe("run-ended");
    expect(notification(stop("room", 137), at(null, engaged))?.kind).toBe("run-ended");
    expect(notification(stop("build", 0), at(null, engaged))?.kind).toBe("run-ended");
  });

  test("a reviewer or fix agent that ended cleanly is silent; one that failed pages", () => {
    const stop = (role: string, data: Record<string, unknown>) =>
      ({
        v: 1,
        ts: "t",
        project: "acme",
        spec: "auth",
        type: "agent_session_stopped",
        agent: "codex",
        host: "h",
        data: { run_role: role, ...data },
      }) as SailEvent;
    expect(notification(stop("review", { exit_code: 0 }), at(null, engaged))).toBeNull();
    expect(notification(stop("fix", { exit_code: 0 }), at(null, engaged))).toBeNull();
    expect(notification(stop("review", { exit_code: 1 }), at(null, engaged))?.kind).toBe("run-ended");
    expect(notification(stop("fix", { reason: "time limit (45m)" }), at(null, engaged))?.kind).toBe(
      "run-ended",
    );
  });

  test("a chat turn the watcher killed pages though it carries no exit code", () => {
    const killed = {
      v: 1,
      ts: "t",
      project: "acme",
      spec: "chat-room",
      type: "agent_session_stopped",
      agent: "claude-code",
      host: "h",
      data: { run_role: "room", reason: "stall (20m)" },
    } as SailEvent;
    expect(notification(killed, at(null, engaged))?.kind).toBe("run-ended");
  });
});


describe("a teammate's message", () => {
  const ROOM_A = "room-a";
  const ROOM_B = "room-b";
  const titles: Record<string, string> = { [ROOM_B]: "Design talk" };
  const posted = (agent: string, preview = "the build is green") =>
    event("spec_message_posted", { spec: ROOM_B, agent, data: { message_id: "m9", preview } });
  const facts = (overrides: Partial<NotifyFacts> = {}): NotifyFacts => ({
    onScreen: (id) => id === ROOM_A,
    windowFocused: true,
    me: "uday",
    roomTitle: (id) => titles[id],
    ...overrides,
  });

  test("in another room of a focused window, it toasts naming who and where, and nothing more", () => {
    expect(notification(posted("bob"), facts())).toEqual({
      kind: "message",
      tone: "info",
      specId: ROOM_B,
      message: "bob wrote · Design talk",
      detail: "the build is green",
      toast: true,
      desktop: false,
    });
  });

  test("in a window you are not using, it raises an OS notification and counts on the badge", () => {
    const decision = notification(posted("bob"), facts({ windowFocused: false }));
    expect(decision?.desktop).toBe(true);
    expect(decision?.toast).toBe(false);
  });

  test("the room you are looking at stays quiet, until the window is not the one you use", () => {
    expect(notification(posted("bob"), facts({ onScreen: (id) => id === ROOM_B }))).toBeNull();
    expect(
      notification(posted("bob"), facts({ onScreen: (id) => id === ROOM_B, windowFocused: false }))?.desktop,
    ).toBe(true);
  });

  test("your own message never notifies, wherever you posted it from", () => {
    expect(notification(posted("uday"), facts())).toBeNull();
    expect(notification(posted("uday"), facts({ windowFocused: false }))).toBeNull();
    expect(notification(posted("uday", "@uday note to self"), facts({ windowFocused: false }))).toBeNull();
  });

  test("before whoami says who you are, a person's message notifies no one", () => {
    expect(notification(posted("bob"), facts({ me: undefined }))).toBeNull();
  });

  test("sail's own posts are not a teammate's", () => {
    expect(notification(posted("sail"), facts())).toBeNull();
  });

  test("a room with no title known is named by its id", () => {
    expect(notification(posted("bob"), facts({ roomTitle: () => undefined }))?.message).toBe(
      "bob wrote · room-b",
    );
  });

  test("a mention of you raises the OS notification and the badge even where a plain message only toasts", () => {
    expect(notification(posted("bob", "@uday can you look?"), facts())).toMatchObject({
      kind: "mention",
      message: "bob mentioned you · Design talk",
      toast: true,
      desktop: true,
    });
    expect(notification(posted("bob", "@uday can you look?"), facts({ windowFocused: false }))).toMatchObject({
      toast: false,
      desktop: true,
    });
    expect(notification(posted("bob", "@udayk can you look?"), facts())?.kind).toBe("message");
  });

  describe("a preview the box clipped at 160 code points", () => {
    const clip = (body: string) => [...body.replace(/\s+/g, " ").trim()].slice(0, 160).join("");
    const late = `${"x".repeat(170)} @uday please look`;
    const cut = `${"y".repeat(154)} @udaykiran can you look`;

    test("is read whole before deciding, so a mention past the cut is a mention", () => {
      const event = posted("bob", clip(late));
      expect(needsBody(event, "uday")).toBe(true);
      expect(notification(event, facts({ body: late }))?.kind).toBe("mention");
      expect(notification(event, facts({ body: late }))?.detail).toBe(clip(late));
    });

    test("is never read for a mention in its last word, which the cut may have shortened", () => {
      expect(clip(cut).endsWith("@uday")).toBe(true);
      expect(notification(posted("bob", clip(cut)), facts())?.kind).toBe("message");
      expect(notification(posted("bob", clip(cut)), facts({ body: cut }))?.kind).toBe("message");
    });

    test("one the box did not clip is read as it is, to its last word", () => {
      const event = posted("bob", "can you look, @uday");
      expect(needsBody(event, "uday")).toBe(false);
      expect(notification(event, facts())?.kind).toBe("mention");
    });

    test("is not read for your own message, sail's, or before whoami", () => {
      const long = clip(late);
      expect(needsBody(posted("uday", long), "uday")).toBe(false);
      expect(needsBody(posted("sail", long), "uday")).toBe(false);
      expect(needsBody(posted("bob", long), undefined)).toBe(false);
      expect(needsBody(event("agent_failed", { data: { preview: long } }), "uday")).toBe(false);
    });

    test("counts code points, as the box does", () => {
      expect(needsBody(posted("bob", "😀".repeat(159)), "uday")).toBe(false);
      expect(needsBody(posted("bob", "😀".repeat(160)), "uday")).toBe(true);
    });
  });

  test("a handle quoted as code mentions no one", () => {
    expect(notification(posted("bob", "run `sail fde add @uday`"), facts())?.kind).toBe("message");
  });

  test("a mention of you in the room you are looking at stays quiet", () => {
    expect(notification(posted("bob", "@uday here"), facts({ onScreen: (id) => id === ROOM_B }))).toBeNull();
  });

  test("an agent that mentions you notifies though its room is not engaged", () => {
    expect(notification(posted("claude/run-1", "@uday the PR is up"), facts())).toMatchObject({
      kind: "mention",
      message: "claude mentioned you · Design talk",
    });
    expect(notification(posted("claude/run-1", "the PR is up"), facts())).toBeNull();
  });

  test("agent rules toast as they did, whether or not the window is focused", () => {
    const question = event("spec_message_posted", { spec: ROOM_B, data: { question: true } });
    expect(notification(question, facts({ windowFocused: false }))).toMatchObject({
      kind: "needs-reply",
      toast: true,
      desktop: false,
    });
    expect(notification(event("agent_failed", { spec: ROOM_B }), facts())).toMatchObject({
      kind: "run-ended",
      toast: true,
      desktop: false,
    });
  });
});
