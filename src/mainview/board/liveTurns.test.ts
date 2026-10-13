import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import {
  liveTurns,
  NO_LIVE_TURNS,
  settleLiveTurns,
  streamGapped,
  type LiveTurns,
} from "./liveTurns";

const PRINCIPAL = "claude-code/run-1";

function live(type: string, data: Record<string, unknown> = {}): SailEvent {
  return {
    v: 1,
    ts: "2026-10-13T10:00:00Z",
    project: "mast",
    spec: "room-1",
    type,
    agent: "claude-code",
    host: "devbox",
    data: { run_id: "run-1", room_id: "room-1", principal: PRINCIPAL, turn: 7, ...data },
  };
}

const delta = (text: unknown, more: Record<string, unknown> = {}) =>
  live("agent_text_delta", { text, ...more });
const toolCall = (status: string, more: Record<string, unknown> = {}) =>
  live("agent_tool_call", { tool: "Read", status, ...more });
const turnEnded = (more: Record<string, unknown> = {}) =>
  live("agent_turn_ended", { is_error: false, ...more });
const at = (event: SailEvent, ts: string): SailEvent => ({ ...event, ts });

const fold = (events: SailEvent[], from: LiveTurns = NO_LIVE_TURNS) =>
  events.reduce(liveTurns, from);
const room = (...ids: string[]) =>
  ids.map((id) => ({ id, author: "uday", created_at: "2026-10-13T10:00:05Z" }));
const reply = (id: string, more: { created_at?: string; question?: boolean } = {}) => ({
  id,
  author: PRINCIPAL,
  created_at: "2026-10-13T10:00:05Z",
  ...more,
});

describe("a turn is drawn once", () => {
  test("the deltas of one turn grow one draft, named by the event's principal", () => {
    const state = fold([delta("Hello"), delta(", "), delta("room.")]);

    expect(state.drafts).toEqual([
      {
        runId: "run-1",
        turn: 7,
        principal: PRINCIPAL,
        text: "Hello, room.",
        tools: [],
        gapped: false,
        firstEventAt: Date.parse("2026-10-13T10:00:00Z"),
      },
    ]);
  });

  test("a tool call is one line from its summary, running until it finishes", () => {
    const started = fold([delta("Looking."), toolCall("started", { summary: "README.md" })]);
    expect(started.drafts[0]!.tools).toEqual([{ tool: "Read", summary: "README.md", running: true }]);

    const finished = liveTurns(started, toolCall("finished"));
    expect(finished.drafts[0]!.tools).toEqual([
      { tool: "Read", summary: "README.md", running: false },
    ]);
  });

  test("a finish closes the oldest running call of its tool, and one nothing started is ignored", () => {
    const state = fold([
      toolCall("started", { summary: "a.ts" }),
      toolCall("started", { summary: "b.ts" }),
      toolCall("finished"),
      toolCall("finished", { tool: "Bash" }),
    ]);

    expect(state.drafts[0]!.tools.map((line) => [line.summary, line.running])).toEqual([
      ["a.ts", false],
      ["b.ts", true],
    ]);
  });

  test("a turn of tools alone opens a draft before any text", () => {
    const state = fold([toolCall("started", { summary: "bun test" })]);

    expect(state.drafts).toHaveLength(1);
    expect(state.drafts[0]!.text).toBe("");
  });

  test("the loop's own tool events, which carry no turn, draw nothing", () => {
    const loop: SailEvent = { ...live("agent_tool_started"), data: { run_id: "run-1" } };

    expect(liveTurns(NO_LIVE_TURNS, loop)).toBe(NO_LIVE_TURNS);
    expect(liveTurns(NO_LIVE_TURNS, { ...loop, type: "agent_tool_finished" })).toBe(NO_LIVE_TURNS);
  });

  test("the next turn of the same run is a draft of its own", () => {
    const state = fold([delta("First."), turnEnded({ message_id: "m-1" }), delta("Second.", { turn: 8 })]);

    expect(state.drafts.map((draft) => [draft.turn, draft.text])).toEqual([
      [7, "First."],
      [8, "Second."],
    ]);
  });
});

describe("the message takes the draft's place", () => {
  test("a turn end naming a message the room already holds drops the draft at once", () => {
    const ended = fold([delta("Done."), turnEnded({ message_id: "m-1" })]);

    expect(settleLiveTurns(ended, room("m-0", "m-1"))).toEqual(NO_LIVE_TURNS);
  });

  test("a turn end before its message holds the draft until the message arrives", () => {
    const ended = fold([delta("Done."), turnEnded({ message_id: "m-1" })]);

    const waiting = settleLiveTurns(ended, room("m-0"));
    expect(waiting).toBe(ended);
    expect(waiting.drafts[0]!.text).toBe("Done.");

    expect(settleLiveTurns(waiting, room("m-0", "m-1")).drafts).toEqual([]);
  });

  test("a turn that ends having said nothing leaves nothing to replace", () => {
    const state = fold([toolCall("started", { summary: "bun test" }), turnEnded()]);

    expect(state.drafts).toEqual([]);
  });

  test("a turn end for a turn that was never drawn is nothing", () => {
    expect(liveTurns(NO_LIVE_TURNS, turnEnded({ message_id: "m-1" }))).toBe(NO_LIVE_TURNS);
  });

  test("an open turn is not replaced by a message its principal posts mid-turn", () => {
    const writing = fold([delta("Let me note this.")]);

    expect(settleLiveTurns(writing, [reply("note-1")])).toBe(writing);
  });

  test("a turn that begins drops the drafts before it, except one that waits for its message", () => {
    const owed = fold([delta("First."), turnEnded({ message_id: "m-1" })]);
    const failed = fold([delta("Second.", { turn: 8 }), turnEnded({ turn: 8, is_error: true })], owed);
    expect(failed.drafts.map((draft) => draft.turn)).toEqual([7, 8]);

    const next = liveTurns(failed, delta("Third.", { turn: 9 }));
    expect(next.drafts.map((draft) => draft.turn)).toEqual([7, 9]);
  });
});

describe("a reconnect loses nothing a reader needs", () => {
  test("a gap keeps what arrived, marks where text went missing, and the turn goes on", () => {
    const gapped = streamGapped(fold([delta("Half a sent")]));
    expect(gapped.drafts[0]!.text).toBe("Half a sent … ");

    const resumed = liveTurns(streamGapped(gapped), delta("and the rest."));
    expect(resumed.drafts[0]!.text).toBe("Half a sent … and the rest.");

    const ended = liveTurns(resumed, turnEnded({ message_id: "m-1" }));
    expect(settleLiveTurns(ended, room("m-1")).drafts).toEqual([]);
  });

  test("a gap that swallowed the turn's end still yields to the reply its principal wrote", () => {
    const gapped = streamGapped(fold([delta("Half a sent")]));

    expect(settleLiveTurns(gapped, room("m-0"))).toBe(gapped);
    expect(settleLiveTurns(gapped, [...room("m-0"), reply("m-1")]).drafts).toEqual([]);
  });

  test("the room may hold the reply before the gap is noticed, or before the draft is drawn", () => {
    const held = [reply("m-1")];
    const writing = fold([delta("Half a sent")]);
    expect(settleLiveTurns(writing, held)).toBe(writing);

    expect(settleLiveTurns(streamGapped(writing), held).drafts).toEqual([]);
  });

  test("a question its principal asked mid-turn is not the turn's reply, so a gap keeps the draft", () => {
    const gapped = streamGapped(fold([delta("Let me ask.")]));
    const question = reply("question-1", { question: true });

    expect(settleLiveTurns(gapped, [question])).toBe(gapped);
    expect(settleLiveTurns(gapped, [question, reply("m-1")]).drafts).toEqual([]);
  });

  test("another author's message never replaces a draft, gap or not", () => {
    const gapped = streamGapped(fold([delta("Half a sent")]));

    expect(settleLiveTurns(gapped, room("m-1"))).toBe(gapped);
  });

  test("a message written before the turn's first event is an earlier turn's reply", () => {
    const gapped = streamGapped(
      fold([delta("Half a sent"), at(delta("ence"), "2026-10-13T10:00:09Z")]),
    );

    expect(settleLiveTurns(gapped, [reply("m-0", { created_at: "2026-10-13T09:59:59.999Z" })]))
      .toBe(gapped);
    expect(
      settleLiveTurns(gapped, [reply("m-1", { created_at: "2026-10-13T10:00:00Z" })]).drafts,
    ).toEqual([]);
  });

  test("a gapped draft outlives the turn after it, and each yields to a reply written since it began", () => {
    const seventh = streamGapped(fold([delta("Seventh, half")]));
    const both = streamGapped(
      liveTurns(seventh, at(delta("Eighth, half", { turn: 8 }), "2026-10-13T10:00:10Z")),
    );
    expect(both.drafts.map((draft) => draft.turn)).toEqual([7, 8]);

    const seventhReply = reply("m-7", { created_at: "2026-10-13T10:00:05Z" });
    const eighthReply = reply("m-8", { created_at: "2026-10-13T10:00:15Z" });
    expect(settleLiveTurns(both, [seventhReply]).drafts.map((draft) => draft.turn)).toEqual([8]);
    expect(settleLiveTurns(both, [seventhReply, eighthReply]).drafts).toEqual([]);
    expect(settleLiveTurns(both, [eighthReply]).drafts).toEqual([]);
  });

  test("a draft no gap touched is dropped by the turn after it", () => {
    const next = fold([delta("Seventh, half"), delta("Eighth, half", { turn: 8 })]);

    expect(next.drafts.map((draft) => draft.turn)).toEqual([8]);
  });

  test("a time that cannot be read never replaces a draft, the message's or the turn's", () => {
    const gapped = streamGapped(fold([delta("Half a sent")]));
    expect(settleLiveTurns(gapped, [reply("m-1", { created_at: "soon" })])).toBe(gapped);

    const undated = streamGapped(fold([at(delta("Half a sent"), "")]));
    expect(settleLiveTurns(undated, [reply("m-1")])).toBe(undated);
  });

  test("a gap with no turn open changes nothing", () => {
    expect(streamGapped(NO_LIVE_TURNS)).toBe(NO_LIVE_TURNS);
    const ended = fold([delta("Done."), turnEnded({ message_id: "m-1" })]);
    expect(streamGapped(ended)).toBe(ended);
  });
});

describe("an error turn is told", () => {
  test("the draft ends early with the box's reason, its tools no longer running", () => {
    const state = fold([
      delta("Partial"),
      toolCall("started", { summary: "bun test" }),
      turnEnded({ is_error: true, reason: "max_duration reached", message_id: "m-1" }),
    ]);

    expect(state.drafts[0]!.ended).toEqual({
      messageId: "m-1",
      isError: true,
      reason: "max_duration reached",
    });
    expect(state.drafts[0]!.tools[0]!.running).toBe(false);
  });

  test("the posted partial text takes the draft's place and stays marked as cut short", () => {
    const ended = fold([delta("Partial"), turnEnded({ is_error: true, reason: "killed", message_id: "m-1" })]);

    const settled = settleLiveTurns(ended, room("m-1"));
    expect(settled.drafts).toEqual([]);
    expect([...settled.cutShort]).toEqual([["m-1", "killed"]]);
  });

  test("an error turn that posted nothing stays as a draft; one never drawn is still told", () => {
    const silent = liveTurns(NO_LIVE_TURNS, turnEnded({ is_error: true }));

    expect(silent.drafts).toHaveLength(1);
    expect(silent.drafts[0]!.ended).toEqual({ messageId: undefined, isError: true, reason: "" });
    expect(settleLiveTurns(silent, room("m-1"))).toBe(silent);
  });

  test("a clean turn end leaves its message unmarked", () => {
    const ended = fold([delta("Done."), turnEnded({ message_id: "m-1" })]);

    expect(settleLiveTurns(ended, room("m-1")).cutShort.size).toBe(0);
  });
});

describe("event payloads are untrusted", () => {
  test("an event without a run, a turn or a principal is ignored", () => {
    for (const missing of [{ run_id: undefined }, { turn: "7" }, { principal: "" }, { turn: Number.NaN }]) {
      expect(liveTurns(NO_LIVE_TURNS, delta("x", missing))).toBe(NO_LIVE_TURNS);
    }
    expect(liveTurns(NO_LIVE_TURNS, { ...delta("x"), data: undefined })).toBe(NO_LIVE_TURNS);
  });

  test("an event of any other type is ignored", () => {
    expect(liveTurns(NO_LIVE_TURNS, live("spec_status_changed"))).toBe(NO_LIVE_TURNS);
  });

  test("text, summaries, names and reasons are clipped, and a non-string is nothing", () => {
    const state = fold([
      delta("a".repeat(70_000)),
      delta({ html: "<b>" }),
      toolCall("started", { tool: "T".repeat(500), summary: "s".repeat(500) }),
      turnEnded({ is_error: true, reason: "r".repeat(500) }),
    ]);
    const draft = state.drafts[0]!;

    expect(draft.text).toHaveLength(65_536);
    expect(draft.tools[0]!.tool).toHaveLength(80);
    expect(draft.tools[0]!.summary).toHaveLength(160);
    expect(draft.ended!.reason).toHaveLength(240);
    expect(liveTurns(NO_LIVE_TURNS, delta("x", { principal: "p".repeat(500) })).drafts[0]!.principal)
      .toHaveLength(80);
  });

  test("a turn keeps only its newest tool lines", () => {
    const calls = Array.from({ length: 60 }, (_, index) =>
      toolCall("started", { summary: `file-${index}` }),
    );

    const tools = fold(calls).drafts[0]!.tools;
    expect(tools).toHaveLength(50);
    expect(tools.at(-1)!.summary).toBe("file-59");
  });

  test("a tool call with an unknown status draws nothing", () => {
    expect(fold([toolCall("exploded")]).drafts[0]!.tools).toEqual([]);
  });
});
