import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import {
  chipTitle,
  commandFor,
  deckSessions,
  type DeckSession,
  endedReasons,
  glyphFor,
  isDeckEvent,
  isResumeSession,
  nextRoomSession,
  observerCount,
  skewCard,
  skewOf,
  yieldedDispatch,
} from "./roomDeck";

const session = (over: Partial<DeckSession>): DeckSession => ({
  name: "room-design-talk",
  live: true,
  attached: 1,
  writerFde: "uday",
  room: "design-talk",
  command: ["bash", "-l"],
  ...over,
});

describe("deckSessions", () => {
  test("keeps only the room's sessions, live first, then by name", () => {
    const all = [
      session({ name: "room-design-talk.2", live: false }),
      session({ name: "mast-node", room: "" }),
      session({ name: "room-design-talk" }),
      session({ name: "other", room: "another-room" }),
      session({ name: "resume-run-7" }),
    ];
    expect(deckSessions(all, "design-talk").map((s) => s.name)).toEqual([
      "resume-run-7",
      "room-design-talk",
      "room-design-talk.2",
    ]);
  });
});

describe("glyphFor", () => {
  test("reads the executable basename", () => {
    expect(glyphFor(["claude"])).toBe("claude");
    expect(glyphFor(["/usr/local/bin/claude", "--resume", "r1"])).toBe("claude");
    expect(glyphFor(["codex", "resume"])).toBe("codex");
    expect(glyphFor(["bash", "-l"])).toBe("shell");
    expect(glyphFor([])).toBe("shell");
  });

  test("round-trips the picker's commands", () => {
    expect(glyphFor(commandFor("claude"))).toBe("claude");
    expect(glyphFor(commandFor("codex"))).toBe("codex");
    expect(glyphFor(commandFor("shell"))).toBe("shell");
  });
});

describe("room session naming", () => {
  test("mints the base name first, then the lowest free ordinal", () => {
    expect(nextRoomSession("design-talk", [])).toBe("room-design-talk");
    expect(nextRoomSession("design-talk", ["room-design-talk"])).toBe("room-design-talk.2");
    expect(
      nextRoomSession("design-talk", ["room-design-talk", "room-design-talk.3"]),
    ).toBe("room-design-talk.2");
  });

  test("resume sessions are recognized and keep their identity as the title", () => {
    expect(isResumeSession("resume-run-7")).toBe(true);
    expect(isResumeSession("room-x")).toBe(false);
    expect(chipTitle(session({ name: "resume-run-7" }), "design-talk")).toBe("resume-run-7");
  });

  test("a chip is titled by OSC first, then its ordinal", () => {
    expect(chipTitle(session({}), "design-talk", "vim mast")).toBe("vim mast");
    expect(chipTitle(session({}), "design-talk")).toBe("1");
    expect(chipTitle(session({ name: "room-design-talk.2" }), "design-talk")).toBe("2");
  });
});

describe("observerCount", () => {
  test("everyone beyond the writer observes", () => {
    expect(observerCount(session({ attached: 3, writerFde: "uday" }))).toBe(2);
    expect(observerCount(session({ attached: 2, writerFde: "" }))).toBe(2);
    expect(observerCount(session({ attached: 0, writerFde: "" }))).toBe(0);
  });
});

describe("skew", () => {
  test("a SAILPTY1 echo names the box as the older side", () => {
    expect(skewOf("pty protocol skew: the box speaks SAILPTY1")).toBe("box-older");
    expect(skewCard("box-older").detail).toContain("sail upgrade");
  });

  test("any other mismatch names this Mast as the older side", () => {
    expect(skewOf("pty protocol skew: the box no longer speaks SAILPTY2")).toBe("mast-older");
    expect(skewCard("mast-older").title).toBe("This Mast is older than the box");
  });

  test("ordinary failures are not skew", () => {
    expect(skewOf("connection reset by peer")).toBe(null);
    expect(skewOf(undefined)).toBe(null);
  });
});

const event = (over: Partial<SailEvent>): SailEvent => ({
  v: 1,
  ts: "2026-08-31T12:00:00Z",
  project: "sail-mast",
  type: "pty_session_started",
  agent: "uday",
  host: "devbox",
  ...over,
});

describe("deck events", () => {
  test("pty events for the room refresh the deck; others do not", () => {
    expect(isDeckEvent(event({ spec: "design-talk" }), "design-talk")).toBe(true);
    expect(
      isDeckEvent(event({ data: { room_id: "design-talk" } }), "design-talk"),
    ).toBe(true);
    expect(isDeckEvent(event({ spec: "another" }), "design-talk")).toBe(false);
    expect(
      isDeckEvent(event({ type: "spec_message_posted", spec: "design-talk" }), "design-talk"),
    ).toBe(false);
  });

  test("the last ended reason per session wins", () => {
    const reasons = endedReasons([
      event({ type: "pty_session_ended", data: { session: "a", reason: "exited(1)" } }),
      event({ type: "pty_session_ended", data: { session: "a", reason: "exited(0)" } }),
      event({ type: "pty_session_started", data: { session: "b" } }),
    ]);
    expect(reasons).toEqual({ a: "exited(0)" });
  });
});

describe("yieldedDispatch", () => {
  test("parses the dispatch displacement notice, with and without a spec", () => {
    expect(yieldedDispatch("yielded to dispatch r1 of spec design-talk")).toEqual({
      runId: "r1",
      specId: "design-talk",
    });
    expect(yieldedDispatch("yielded to dispatch r1")).toEqual({ runId: "r1" });
    expect(yieldedDispatch("exited(0)")).toBe(null);
    expect(yieldedDispatch(undefined)).toBe(null);
  });
});
