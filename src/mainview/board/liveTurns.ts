import type { SailEvent } from "../../shared/sail-models";

/**
 * A live member's turns as they are written: the box streams a turn's text and tool steps as
 * ephemeral events, and this folds them into one draft per `(run_id, turn)` that stands in the
 * room until the message the turn became takes its place. Nothing here is a record: a room
 * opened after the turn reads the message alone, so every draft is safe to drop.
 *
 * Framework-free and pure; the room holds the state and says which messages it has.
 */

export const LIVE_TURN_EVENT_TYPES = ["agent_text_delta", "agent_tool_call", "agent_turn_ended"];

const LIVE_TURN_EVENTS = new Set(LIVE_TURN_EVENT_TYPES);

export function isLiveTurnEvent(type: string): boolean {
  return LIVE_TURN_EVENTS.has(type);
}

/** A room message's own bound: a draft never outgrows the message it becomes. */
const TEXT_LIMIT = 65_536;
const SUMMARY_LIMIT = 160;
const NAME_LIMIT = 80;
const REASON_LIMIT = 240;
const TOOL_LINE_LIMIT = 50;
const GAP_MARK = " … ";

export type ToolLine = { tool: string; summary: string; running: boolean };

export type Draft = {
  runId: string;
  turn: number;
  /** The member's author string, the one its message will carry. */
  principal: string;
  text: string;
  tools: ToolLine[];
  /** The stream dropped while this turn was open, so its end may never be told. */
  gapped: boolean;
  /** The box's time on the first event of the turn the room saw; NaN when it was unreadable. */
  firstEventAt: number;
  ended?: { messageId?: string; isError: boolean; reason: string };
};

/** A message the room holds, as far as a draft reads it. */
export type HeldMessage = { id: string; author: string; question?: boolean; created_at: string };

export type LiveTurns = {
  /** Oldest first; more than one only while a turn that is over still waits for its message. */
  drafts: Draft[];
  /** Messages whose turn ended early, with the box's reason ("" when it gave none). */
  cutShort: ReadonlyMap<string, string>;
};

export const NO_LIVE_TURNS: LiveTurns = { drafts: [], cutShort: new Map() };

/** Event payloads are untrusted: a field is the string it claims to be, bounded, or nothing. */
function clip(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Whether a message the room holds takes the draft's place. A turn's end names its message. An
 * end a stream gap may have swallowed is read off the room instead: the draft yields to a reply
 * its principal wrote since the turn's first event, however and whenever the room came to hold
 * it. The box that runs the member stamps both times, so an earlier turn's reply is older; a
 * question is asked mid-turn and is never the reply; a time that cannot be read is no reply.
 */
function replacedBy(draft: Draft, messages: readonly HeldMessage[]): boolean {
  if (draft.ended) {
    const named = draft.ended.messageId;
    return messages.some((message) => message.id === named);
  }
  return (
    draft.gapped &&
    messages.some(
      (message) =>
        message.author === draft.principal &&
        !message.question &&
        Date.parse(message.created_at) >= draft.firstEventAt,
    )
  );
}

/** A draft whose turn is over waits only for a message: the one its end named, or the reply
 *  of an end a gap may have swallowed. */
function awaitsMessage(draft: Draft): boolean {
  return draft.ended ? draft.ended.messageId !== undefined : draft.gapped;
}

function update(state: LiveTurns, draft: Draft, next: Draft): LiveTurns {
  return {
    ...state,
    drafts: state.drafts.map((candidate) => (candidate === draft ? next : candidate)),
  };
}

function withToolCall(draft: Draft, data: Record<string, unknown>): Draft {
  const tool = clip(data.tool, NAME_LIMIT);
  if (data.status === "started") {
    const line = { tool, summary: clip(data.summary, SUMMARY_LIMIT), running: true };
    return { ...draft, tools: [...draft.tools, line].slice(-TOOL_LINE_LIMIT) };
  }
  const finished = draft.tools.findIndex((line) => line.running && line.tool === tool);
  if (data.status !== "finished" || finished < 0) return draft;
  return {
    ...draft,
    tools: draft.tools.map((line, index) =>
      index === finished ? { ...line, running: false } : line,
    ),
  };
}

/**
 * Folds one live event in. Anything else, and any live event without a run, a turn and a
 * principal, leaves the state as it was.
 */
export function liveTurns(state: LiveTurns, event: SailEvent): LiveTurns {
  if (!isLiveTurnEvent(event.type)) return state;
  const data = event.data ?? {};
  const runId = clip(data.run_id, NAME_LIMIT);
  const principal = clip(data.principal, NAME_LIMIT);
  const turn = data.turn;
  if (!runId || !principal || typeof turn !== "number" || !Number.isFinite(turn)) return state;

  const ending = event.type === "agent_turn_ended";
  const known = state.drafts.find(
    (candidate) => candidate.runId === runId && candidate.turn === turn,
  );
  if (known?.ended) return state;
  if (!known && ending && data.is_error !== true) return state;

  // A room has one member and a member one turn at a time, so a turn that begins ends every
  // draft before it; only one that still waits for its message stays to be replaced by it.
  const begun: Draft = {
    runId,
    turn,
    principal,
    text: "",
    tools: [],
    gapped: false,
    firstEventAt: Date.parse(event.ts),
  };
  const opened = known
    ? state
    : {
        ...state,
        drafts: [...state.drafts.filter(awaitsMessage), begun],
      };
  const draft = known ?? begun;

  if (event.type === "agent_text_delta") {
    return update(opened, draft, {
      ...draft,
      text: (draft.text + clip(data.text, TEXT_LIMIT)).slice(0, TEXT_LIMIT),
    });
  }
  if (event.type === "agent_tool_call") return update(opened, draft, withToolCall(draft, data));

  const messageId =
    typeof data.message_id === "string" && data.message_id ? data.message_id : undefined;
  const isError = data.is_error === true;
  if (!messageId && !isError) {
    return { ...opened, drafts: opened.drafts.filter((candidate) => candidate !== draft) };
  }
  return update(opened, draft, {
    ...draft,
    tools: draft.tools.map((line) => (line.running ? { ...line, running: false } : line)),
    ended: { messageId, isError, reason: clip(data.reason, REASON_LIMIT) },
  });
}

/** The stream dropped: every open draft keeps what arrived and marks where text went missing. */
export function streamGapped(state: LiveTurns): LiveTurns {
  if (!state.drafts.some((draft) => !draft.ended)) return state;
  return {
    ...state,
    drafts: state.drafts.map((draft) =>
      draft.ended
        ? draft
        : {
            ...draft,
            gapped: true,
            text:
              draft.text === "" || draft.text.endsWith(GAP_MARK)
                ? draft.text
                : draft.text + GAP_MARK,
          },
    ),
  };
}

/**
 * Drops every draft a message the room holds takes the place of, remembering which of those
 * messages a turn that ended early left behind. Returns the same state when nothing was replaced.
 */
export function settleLiveTurns(state: LiveTurns, messages: readonly HeldMessage[]): LiveTurns {
  const replaced = state.drafts.filter((draft) => replacedBy(draft, messages));
  if (replaced.length === 0) return state;
  const cutShort = new Map(state.cutShort);
  for (const { ended } of replaced) {
    if (ended?.isError && ended.messageId) cutShort.set(ended.messageId, ended.reason);
  }
  return { drafts: state.drafts.filter((draft) => !replaced.includes(draft)), cutShort };
}
