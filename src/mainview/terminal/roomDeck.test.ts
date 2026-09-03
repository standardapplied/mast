import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import {
  chipTitle,
  closedSessions,
  commandFor,
  type DeathRecord,
  deckSessions,
  type DeckSession,
  endedCardModel,
  endedReasons,
  glyphFor,
  isPtyEvent,
  isResumeSession,
  nextRoomSession,
  observerCount,
  panePlan,
  preAttachClass,
  roomGroups,
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
  test("an older magic's echo names the box as the older side", () => {
    expect(skewOf("pty protocol skew: the box speaks an older SAILPTY")).toBe("box-older");
    expect(skewCard("box-older").detail).toContain("sail upgrade");
  });

  test("any other mismatch names this Mast as the older side", () => {
    expect(skewOf("pty protocol skew: the box no longer speaks SAILPTY3")).toBe("mast-older");
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

describe("endedCardModel", () => {
  test("a pending death fails closed: holding copy, no restart", () => {
    const model = endedCardModel(
      { reason: "ended", at: 1, room: "design-talk", historyPending: true },
      "ended",
    );
    expect(model.restartable).toBe(false);
    expect(model.reason).toContain("Checking");
  });

  test("a settled death passes the recorded reason through, restartable", () => {
    expect(endedCardModel({ reason: "exited(0)", at: 1 }, "exited(0)")).toEqual({
      reason: "exited(0)",
      restartable: true,
    });
    expect(endedCardModel(undefined, "ended")).toEqual({ reason: "ended", restartable: true });
  });
});

describe("deck events", () => {
  test("pty lifecycle events are the store's refresh cue; others are not", () => {
    expect(isPtyEvent(event({ spec: "design-talk" }))).toBe(true);
    expect(isPtyEvent(event({ type: "pty_session_ended" }))).toBe(true);
    expect(isPtyEvent(event({ type: "spec_message_posted" }))).toBe(false);
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

describe("closedSessions", () => {
  test("only the user's own closes prune an arrangement; exits and restart losses keep their card", () => {
    const deaths = new Map<string, DeathRecord>([
      ["room-r", { reason: "closed from Mast", at: 1, closed: true }],
      ["room-r.2", { reason: "exited(0)", at: 1 }],
      ["room-r.3", { reason: "host restarted", at: 1 }],
    ]);
    expect([...closedSessions(deaths)]).toEqual(["room-r"]);
  });
});

describe("preAttachClass", () => {
  test("a skew failure parks as refused instead of retrying", () => {
    expect(preAttachClass("list: pty protocol skew: the box speaks SAILPTY1")).toBe("refused");
    expect(preAttachClass("pty protocol skew: the box no longer speaks SAILPTY2")).toBe("refused");
  });

  test("anything else stays a transport failure and reattaches on backoff", () => {
    expect(preAttachClass("connection reset by peer")).toBe("transport");
    expect(preAttachClass("channel open refused")).toBe("transport");
  });
});

describe("panePlan", () => {
  const listed = [
    session({ name: "room-design-talk", command: ["claude"], writerFde: "mady" }),
    session({ name: "resume-run-7", live: false, command: ["codex", "resume"] }),
  ];

  test("an explicit launch attaches with its picked command", () => {
    const launched = new Map([["room-design-talk.2", { command: ["codex"] }]]);
    expect(panePlan("room-design-talk.2", listed, launched)).toEqual({
      kind: "attach",
      command: ["codex"],
      writerFde: undefined,
    });
  });

  test("a live listed session attaches with the command it runs and its writer", () => {
    expect(panePlan("room-design-talk", listed, new Map())).toEqual({
      kind: "attach",
      command: ["claude"],
      writerFde: "mady",
    });
  });

  test("a session absent from the host parks on the ended card as provably absent — never a silent recreate", () => {
    expect(panePlan("room-design-talk.3", listed, new Map())).toEqual({
      kind: "ended",
      restartCommand: ["bash", "-l"],
      absent: true,
    });
  });

  test("a listed corpse parks on the ended card — never a silent agent recreate", () => {
    expect(panePlan("resume-run-7", listed, new Map())).toEqual({
      kind: "ended",
      restartCommand: ["codex", "resume"],
    });
  });

  test("an absent session the store watched dying parks on the ended card, revive command from the record", () => {
    const deaths = new Map<string, DeathRecord>([
      ["room-design-talk.3", { reason: "closed from Mast", at: 1, command: ["claude"] }],
    ]);
    expect(panePlan("room-design-talk.3", listed, new Map(), deaths)).toEqual({
      kind: "ended",
      restartCommand: ["claude"],
    });
    expect(
      panePlan("room-design-talk.4", listed, new Map(), deaths),
      "no record — absent is still absent: an ended card that says so, not a shell",
    ).toEqual({ kind: "ended", restartCommand: ["bash", "-l"], absent: true });
  });
});

describe("roomGroups", () => {
  test("groups room sessions by room with titles, ignoring unbound sessions", () => {
    const all = [
      session({ name: "mast-node", room: "" }),
      session({ name: "room-zeta", room: "zeta" }),
      session({ name: "room-design-talk.2", live: false }),
      session({ name: "room-design-talk" }),
    ];
    const groups = roomGroups(all, [
      { id: "design-talk", title: "Design talk", project: "sail-mast" },
    ]);
    expect(groups.map((g) => g.roomId)).toEqual(["design-talk", "zeta"]);
    expect(groups[0]).toMatchObject({ title: "Design talk", project: "sail-mast" });
    expect(groups[0]!.sessions.map((s) => s.name)).toEqual([
      "room-design-talk",
      "room-design-talk.2",
    ]);
    // An unknown room never disappears from the inventory — it falls back to its id.
    expect(groups[1]).toMatchObject({ title: "zeta", project: "" });
  });
});
