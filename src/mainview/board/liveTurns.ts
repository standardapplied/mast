import type { SailEvent } from "../../shared/sail-models";

/**
 * A live member's turns as they are written: the box streams a turn's text and tool steps as
 * ephemeral events, and this folds them into one draft per `(run_id, turn)` that stands in the
 * room until the message the turn became takes its place. Nothing here is a record: a room
 * opened after the turn reads the message alone, so every draft is safe to drop.
 *
 * Framework-free and pure; the room holds the state and says which messages it has.
 */

export const LIVE_TURN_EVENT_TYPES = [
  "agent_turn_state",
  "agent_turn_began",
  "agent_text_delta",
  "agent_tool_call",
  "agent_turn_ended",
];

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
/** More drafts than this are ends naming messages that never came. */
const DRAFT_LIMIT = 8;
const GAP_MARK = " … ";

export type ToolLine = { tool: string; summary: string; running: boolean };

export type Draft = {
  runId: string;
  turn: number;
  /** The member's author string, the one its message will carry. */
  principal: string;
  text: string;
  tools: ToolLine[];
  /** The stream dropped and nothing of the turn has arrived since: is it still working? */
  gapped: boolean;
  /**
   * The reader was away from the latest when the turn began, so it waits behind the "new" pill
   * as a message arriving then would, until they return. Decided once: a draft drawn by where
   * the reader is would move where the reader is.
   */
  behind: boolean;
  ended?: { messageId?: string; isError: boolean; reason: string };
};

export type LiveTurns = {
  /** Oldest first; more than one only while an ended turn still waits for its message. */
  drafts: Draft[];
  /** Each run's newest turn known over: what is told of it, or of one before, is old news. */
  over: ReadonlyMap<string, number>;
};

/** A message the room holds, as far as a draft reads it. */
export type HeldMessage = { id: string };

export const NO_LIVE_TURNS: LiveTurns = { drafts: [], over: new Map() };

/** Event payloads are untrusted: a field is the string it claims to be, bounded, or nothing. */
function clip(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** The message that takes the draft's place: the one its turn's end named, and nothing else. */
function replacementOf(draft: Draft, messages: readonly HeldMessage[]): string | undefined {
  const named = draft.ended?.messageId;
  return messages.some((message) => message.id === named) ? named : undefined;
}

/** Whether the turn has written anything: a draft that has not stands only for the member working. */
export function hasWritten(draft: Draft): boolean {
  return draft.text !== "" || draft.tools.length > 0;
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

type TurnOf = { runId: string; principal: string; turn: number };

function turnOf(data: Record<string, unknown>): TurnOf | undefined {
  const runId = clip(data.run_id, NAME_LIMIT);
  const principal = clip(data.principal, NAME_LIMIT);
  const turn = data.turn;
  const valid = runId && principal && typeof turn === "number" && Number.isInteger(turn);
  return valid ? { runId, principal, turn } : undefined;
}

function isOver(state: LiveTurns, of: TurnOf): boolean {
  return of.turn <= (state.over.get(of.runId) ?? 0);
}

function emptyDraft(of: TurnOf, behind: boolean): Draft {
  return { ...of, text: "", tools: [], gapped: false, behind };
}

/** The turn ended as `data` says; one the room never saw is drawn only when it failed unsaid. */
function ended(state: LiveTurns, of: TurnOf, data: Record<string, unknown>): LiveTurns {
  const over = new Map(state.over).set(of.runId, Math.max(of.turn, state.over.get(of.runId) ?? 0));
  const known = state.drafts.find((draft) => draft.runId === of.runId && draft.turn === of.turn);
  const messageId =
    typeof data.message_id === "string" && data.message_id ? data.message_id : undefined;
  const isError = data.is_error === true;
  const rest = state.drafts.filter((draft) => draft !== known);
  if (known ? !messageId && !isError : messageId || !isError) return { drafts: rest, over };
  const draft = known ?? emptyDraft(of, false);
  const tools = draft.tools.map((line) => (line.running ? { ...line, running: false } : line));
  const reason = clip(data.reason, REASON_LIMIT);
  const closed = { ...draft, gapped: false, tools, ended: { messageId, isError, reason } };
  return { drafts: [...rest, closed], over };
}

/**
 * Where the member stands, as the box tells a stream that opens. It is believed: the turn it
 * names is open or ended as it says, and every other draft with no end told is dropped.
 */
function stated(state: LiveTurns, data: Record<string, unknown>, readerAway: boolean): LiveTurns {
  const of = turnOf(data);
  const known = of && state.drafts.find((d) => d.runId === of.runId && d.turn === of.turn);
  const told = { ...state, drafts: state.drafts.filter((d) => d.ended || d === known) };
  if (!of || known?.ended || isOver(state, of)) return told;
  if (data.open !== true) return ended(told, of, data);
  const open = known ? { ...known, gapped: false } : emptyDraft(of, readerAway);
  return { ...told, drafts: [...told.drafts.filter((d) => d !== known), open] };
}

/**
 * Folds one live event in. Anything else, any live event without a run, a turn and a principal,
 * one of a turn known to be over, and one that would open a draft with nothing in it, leaves the
 * state as it was: only a turn's beginning, or the box saying it is open, opens an empty draft,
 * which stands for the member working. `readerAway` says where a draft this event opens is placed.
 */
export function liveTurns(state: LiveTurns, event: SailEvent, readerAway = false): LiveTurns {
  if (!isLiveTurnEvent(event.type)) return state;
  const data = event.data ?? {};
  if (event.type === "agent_turn_state") return stated(state, data, readerAway);
  const of = turnOf(data);
  if (!of || isOver(state, of)) return state;
  if (event.type === "agent_turn_ended") return ended(state, of, data);

  const known = state.drafts.find(
    (candidate) => candidate.runId === of.runId && candidate.turn === of.turn,
  );
  // An event of a turn says the turn is still open, whatever a gap before it left in doubt.
  const draft: Draft = { ...(known ?? emptyDraft(of, readerAway)), gapped: false };
  // A room has one member and a member one turn at a time, so a turn that begins ends every
  // draft before it; only one whose end named a message stays to be replaced by it.
  const place = (next: Draft): LiveTurns => ({
    ...state,
    drafts: known
      ? state.drafts.map((candidate) => (candidate === known ? next : candidate))
      : [...state.drafts.filter((one) => one.ended?.messageId), next].slice(-DRAFT_LIMIT),
  });

  if (event.type === "agent_turn_began") return place(draft);
  if (event.type === "agent_text_delta") {
    const text = clip(data.text, TEXT_LIMIT);
    if (!known && text === "") return state;
    return place({ ...draft, text: (draft.text + text).slice(0, TEXT_LIMIT) });
  }
  const called = withToolCall(draft, data);
  return !known && called === draft ? state : place(called);
}

/**
 * The stream dropped: every open draft keeps what arrived and marks where text went missing. One
 * that had written nothing has nothing to keep, so it goes; the frame the stream reopens with
 * says where the turn stands.
 */
export function streamGapped(state: LiveTurns): LiveTurns {
  if (!state.drafts.some((draft) => !draft.ended)) return state;
  return {
    ...state,
    drafts: state.drafts
      .filter((draft) => draft.ended || hasWritten(draft))
      .map((draft) =>
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

/** The reader is back at the latest: every draft that waited behind the pill is drawn. */
export function revealLiveTurns(state: LiveTurns): LiveTurns {
  if (!state.drafts.some((draft) => draft.behind)) return state;
  return { ...state, drafts: state.drafts.map((draft) => ({ ...draft, behind: false })) };
}

/**
 * The messages that take the place of a draft the reader can see. They are drawn where the
 * draft was, wherever the reader is: behind the pill they would leave neither on screen.
 */
export function takingADraftsPlace(state: LiveTurns, messages: readonly HeldMessage[]): string[] {
  return state.drafts
    .filter((draft) => !draft.behind)
    .flatMap((draft) => replacementOf(draft, messages) ?? []);
}

/** Drops every draft a message the room holds takes the place of; the same state when none. */
export function settleLiveTurns(state: LiveTurns, messages: readonly HeldMessage[]): LiveTurns {
  const replaced = state.drafts.filter((draft) => replacementOf(draft, messages) !== undefined);
  if (replaced.length === 0) return state;
  return { ...state, drafts: state.drafts.filter((draft) => !replaced.includes(draft)) };
}
