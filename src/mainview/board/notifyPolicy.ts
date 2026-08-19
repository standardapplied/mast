import type { SailEvent } from "../../shared/sail-models";

/**
 * The one notification policy (Herdr's lesson: one pure function, not badge
 * logic scattered across hooks). Exactly two things page a human: an agent
 * question appearing in a room (`needs_reply`), and a run reaching a terminal
 * state. Everything else — tool events, log chunks, presence — is ambient and
 * never notifies. The room currently in focus is suppressed: the human is
 * already looking at it.
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
  kind: "needs-reply" | "run-ended" | "agent-reply";
  tone: "info" | "error";
  specId: string;
  message: string;
};

/** Agent principals carry a `/` (claude/run-…); FDE handles and `sail` never do. */
function agentAuthor(author: string): boolean {
  return author.includes("/");
}

const CHAT_LANES = new Set(["room", "room-full", "invite", "invite-full"]);

/** A chat or invite turn that ended cleanly is plumbing, not news — the reply
 *  itself is the notification. Failures stay loud whatever the lane. */
function cleanChatStop(event: SailEvent): boolean {
  if (event.type === "agent_failed") return false;
  const role = event.data?.run_role;
  if (typeof role !== "string" || !CHAT_LANES.has(role)) return false;
  const exit = event.data?.exit_code;
  return exit === undefined || exit === null || exit === 0 || exit === "0";
}

export function notification(
  event: SailEvent,
  focusedSpecId: string | null,
  isEngaged: (specId: string) => boolean = () => false,
): Notification | null {
  const specId = event.spec;
  if (!specId || specId === focusedSpecId) return null;
  if (event.type === "spec_message_posted") {
    if (!agentAuthor(event.agent)) return null;
    if (event.data?.question === true) {
      return {
        kind: "needs-reply",
        tone: "info",
        specId,
        message: `${specId} needs your reply`,
      };
    }
    if (!isEngaged(specId)) return null;
    const agent = event.agent.split("/")[0];
    return {
      kind: "agent-reply",
      tone: "info",
      specId,
      message: `${agent} replied · ${specId}`,
    };
  }
  const label = RUN_END_LABELS[event.type];
  if (!label || cleanChatStop(event)) return null;
  return {
    kind: "run-ended",
    tone: event.type === "agent_failed" ? "error" : "info",
    specId,
    message: `${label} · ${specId}`,
  };
}
