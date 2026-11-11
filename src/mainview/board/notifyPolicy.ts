import type { SailEvent } from "../../shared/sail-models";
import { mentions } from "./mentions";

/**
 * The one notification policy (Herdr's lesson: one pure function, not badge logic scattered
 * across hooks): whether an event notifies, and how — the toast, the OS notification and the Dock
 * badge all ask it. A person's message in another room notifies: a toast while the window is the
 * one in use, an OS notification and a badge count while it is not. A message that mentions you
 * raises the OS notification and the badge wherever a plain one would only toast. Your own
 * messages, and the room you are looking at, never notify. For agents, exactly two things page a
 * human, as toasts: an agent question appearing in a room (`needs_reply`), and a run reaching a
 * terminal state; an engaged agent's reply too. Everything else — tool events, log chunks,
 * presence — is ambient and never notifies.
 *
 * The event-name vocabulary consumed by the log panel lives here too, so
 * "what does this event mean to a human" has a single home.
 */

export const LIFECYCLE_TYPES = new Set(["agent_failed", "spec_stranded"]);
export const RESTART_TYPES = new Set(["agent_session_started", "spec_dispatched"]);
export const RUN_CHANGE_TYPES = new Set([
  "spec_dispatched",
  "spec_restarted",
  "agent_session_started",
  "agent_session_stopped",
  "agent_session_completed",
  "agent_cancelled",
  "agent_failed",
]);

const RUN_END_LABELS: Record<string, string> = {
  agent_session_completed: "Run completed",
  agent_session_stopped: "Run stopped",
  agent_failed: "Run failed",
  agent_cancelled: "Run cancelled",
};

export type Notification = {
  kind: "needs-reply" | "run-ended" | "agent-reply" | "message" | "mention";
  tone: "info" | "error";
  specId: string;
  message: string;
  /** What the message said, as the event previews it: an OS notification's body. */
  detail?: string;
  toast: boolean;
  /** Raised as an OS notification and counted on the Dock badge. */
  desktop: boolean;
};

export type NotifyFacts = {
  /** The room on screen. */
  focusedSpecId: string | null;
  /** The window is the one the person is using. */
  windowFocused: boolean;
  /** The reader's handle, once whoami has said. */
  me?: string;
  isEngaged?: (specId: string) => boolean;
  roomTitle?: (roomId: string) => string | undefined;
};

/** Agent principals carry a `/` (claude/run-…); FDE handles and `sail` never do. */
function agentAuthor(author: string): boolean {
  return author.includes("/");
}

const SAIL = "sail";

const QUIET_LANES = new Set(["room", "room-full", "review", "fix"]);

/** A chat turn, a reviewer or a fix agent that ended cleanly is plumbing, not
 *  news — the reply, or the review's own stage and verdict events, are the
 *  notification. Failures stay loud whatever the lane: a run the watcher
 *  killed carries its `reason` in place of an exit code, so a missing exit
 *  code alone never reads as clean. */
export function quietStop(event: SailEvent): boolean {
  if (event.type === "agent_failed") return false;
  const role = event.data?.run_role;
  if (typeof role !== "string" || !QUIET_LANES.has(role)) return false;
  if (typeof event.data?.reason === "string") return false;
  const exit = event.data?.exit_code;
  return exit === undefined || exit === null || exit === 0 || exit === "0";
}

function paged(
  kind: Notification["kind"],
  specId: string,
  message: string,
  tone: Notification["tone"] = "info",
): Notification {
  return { kind, tone, specId, message, toast: true, desktop: false };
}

/**
 * A message from someone else that is news to the reader: a mention of them, or any person's.
 * Null leaves an agent's plain message to the agent rules.
 */
function personal(event: SailEvent, specId: string, facts: NotifyFacts): Notification | null {
  const { me } = facts;
  if (!me || event.agent === me || event.agent === SAIL) return null;
  const preview = typeof event.data?.preview === "string" ? event.data.preview : "";
  const mentioned = mentions(preview, me);
  if (!mentioned && agentAuthor(event.agent)) return null;
  if (facts.windowFocused && specId === facts.focusedSpecId) return null;
  const who = event.agent.split("/")[0];
  const where = facts.roomTitle?.(specId) ?? specId;
  return {
    kind: mentioned ? "mention" : "message",
    tone: "info",
    specId,
    message: `${who} ${mentioned ? "mentioned you" : "wrote"} · ${where}`,
    detail: preview,
    toast: facts.windowFocused,
    desktop: mentioned || !facts.windowFocused,
  };
}

export function notification(event: SailEvent, facts: NotifyFacts): Notification | null {
  const specId = event.spec;
  if (!specId) return null;
  if (event.type === "spec_message_posted") {
    const decision = personal(event, specId, facts);
    if (decision || !agentAuthor(event.agent) || specId === facts.focusedSpecId) return decision;
    if (event.data?.question === true) {
      return paged("needs-reply", specId, `${specId} needs your reply`);
    }
    if (!facts.isEngaged?.(specId)) return null;
    return paged("agent-reply", specId, `${event.agent.split("/")[0]} replied · ${specId}`);
  }
  const label = RUN_END_LABELS[event.type];
  if (!label || specId === facts.focusedSpecId || quietStop(event)) return null;
  const tone = event.type === "agent_failed" ? "error" : "info";
  return paged("run-ended", specId, `${label} · ${specId}`, tone);
}
