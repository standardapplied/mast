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
  /** The newest message the principal posted while the turn was open. */
  posted?: string;
  ended?: { messageId?: string; isError: boolean; reason: string };
};

export type LiveTurns = {
  /** Oldest first; more than one only while an ended turn still waits for its message. */
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
 * The message that takes the draft's place: the one its turn end named, or, when a stream gap
 * may have swallowed that end, the one its principal posted meanwhile.
 */
function replacementOf(draft: Draft): string | undefined {
  if (draft.ended) return draft.ended.messageId;
  return draft.gapped ? draft.posted : undefined;
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

function posted(state: LiveTurns, event: SailEvent): LiveTurns {
  const messageId = event.data?.message_id;
  const draft = state.drafts.find(
    (candidate) => !candidate.ended && candidate.principal === event.agent,
  );
  if (!draft || typeof messageId !== "string" || !messageId) return state;
  return update(state, draft, { ...draft, posted: messageId });
}

/**
 * Folds one event in: the three live types, and `spec_message_posted`, which is how a turn
 * whose end was lost to a stream gap still finds its message. Anything else, and any live event
 * without a run, a turn and a principal, leaves the state as it was.
 */
export function liveTurns(state: LiveTurns, event: SailEvent): LiveTurns {
  if (event.type === "spec_message_posted") return posted(state, event);
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
  // draft before it; only one still owed its message stays to be replaced by it.
  const begun: Draft = { runId, turn, principal, text: "", tools: [], gapped: false };
  const opened = known
    ? state
    : {
        ...state,
        drafts: [
          ...state.drafts.filter((draft) => replacementOf(draft) !== undefined),
          begun,
        ],
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
 * Drops every draft whose message the room now holds, remembering which of those messages a
 * turn that ended early left behind. Returns the same state when nothing was replaced.
 */
export function settleLiveTurns(
  state: LiveTurns,
  messages: readonly { id: string }[],
): LiveTurns {
  const arrived = (draft: Draft) => {
    const messageId = replacementOf(draft);
    return messageId !== undefined && messages.some((message) => message.id === messageId);
  };
  const replaced = state.drafts.filter(arrived);
  if (replaced.length === 0) return state;
  const cutShort = new Map(state.cutShort);
  for (const { ended } of replaced) {
    if (ended?.isError && ended.messageId) cutShort.set(ended.messageId, ended.reason);
  }
  return { drafts: state.drafts.filter((draft) => !arrived(draft)), cutShort };
}
