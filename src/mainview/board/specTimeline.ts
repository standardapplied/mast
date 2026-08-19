import type {
  Finding,
  ReviewDetailResponse,
  RunView,
  SailEvent,
  SpecMessage,
} from "../../shared/sail-models";

export type MessageDelivery = "pending" | "failed";

export type RoomMessage = SpecMessage & {
  delivery?: MessageDelivery;
  error?: string;
};

export type TimelineDecision = {
  id: string;
  reviewId: string;
  findingId?: string;
  action: "approved" | "dismissed";
  actor: string;
  createdAt: string;
};

export type TimelineItem =
  | {
      kind: "message";
      id: string;
      occurredAt: string;
      message: RoomMessage;
    }
  | {
      kind: "lifecycle";
      id: string;
      occurredAt: string;
      event: SailEvent;
      label: string;
      run?: RunView;
    }
  | {
      kind: "review";
      id: string;
      occurredAt: string;
      review: ReviewDetailResponse["review"];
      findings: Finding[];
    }
  | {
      kind: "decision";
      id: string;
      occurredAt: string;
      decision: TimelineDecision;
    };

export type TimelineGroup =
  | {
      kind: "message-group";
      id: string;
      occurredAt: string;
      author: string;
      messages: Extract<TimelineItem, { kind: "message" }>[];
    }
  | Exclude<TimelineItem, { kind: "message" }>;

type EventRule =
  | { mode: "row"; label: string; kind: "lifecycle" | "decision" }
  | { mode: "overlay"; target: "review" | "lifecycle" | "none" };

export const EVENT_REGISTRY: Readonly<Record<string, EventRule>> = {
  spec_dispatched: { mode: "row", kind: "lifecycle", label: "Dispatched" },
  spec_restarted: { mode: "row", kind: "lifecycle", label: "Re-dispatched" },
  agent_session_stopped: { mode: "row", kind: "lifecycle", label: "Agent stopped" },
  agent_stopped: { mode: "row", kind: "lifecycle", label: "Agent stopped" },
  agent_failed: { mode: "row", kind: "lifecycle", label: "Agent failed" },
  spec_failed: { mode: "row", kind: "lifecycle", label: "Spec failed" },
  agent_cancelled: { mode: "row", kind: "lifecycle", label: "Agent cancelled" },
  spec_cancelled: { mode: "row", kind: "lifecycle", label: "Spec cancelled" },
  spec_stranded: { mode: "row", kind: "lifecycle", label: "Spec stranded" },
  review_approved: { mode: "row", kind: "decision", label: "Review approved" },
  finding_dismissed: { mode: "row", kind: "decision", label: "Finding dismissed" },
  review_stage_started: { mode: "row", kind: "lifecycle", label: "Review started" },
  review_stage_passed: { mode: "row", kind: "lifecycle", label: "Review stage passed" },
  review_stage_failed: { mode: "row", kind: "lifecycle", label: "Review stage failed" },
  review_iteration_started: { mode: "row", kind: "lifecycle", label: "Fix iteration started" },
  guardrail_triggered: { mode: "row", kind: "lifecycle", label: "Guardrail triggered" },
  snapshot_created: { mode: "row", kind: "lifecycle", label: "Snapshot" },
  snapshot_restored: { mode: "row", kind: "lifecycle", label: "Snapshot restored" },
  snapshot_deleted: { mode: "row", kind: "lifecycle", label: "Snapshot deleted" },
  agent_stop_nudged: { mode: "row", kind: "lifecycle", label: "Agent nudged" },
  spec_engaged: { mode: "row", kind: "lifecycle", label: "Agent joined the room" },
  spec_disengaged: { mode: "row", kind: "lifecycle", label: "Agent left the room" },
  spec_engage_failed: { mode: "row", kind: "lifecycle", label: "Engage failed" },
  review_errored: { mode: "row", kind: "lifecycle", label: "Review errored" },
  review_escalated: { mode: "row", kind: "lifecycle", label: "Review escalated" },
  review_pipeline_error: { mode: "row", kind: "lifecycle", label: "Review pipeline error" },
  review_completed: { mode: "overlay", target: "review" },
  spec_status_changed: { mode: "overlay", target: "lifecycle" },
  spec_message_posted: { mode: "overlay", target: "none" },
  board_updated: { mode: "overlay", target: "none" },
};

function dataString(event: SailEvent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event.data?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  snapshot_restored: "Snapshot restore failed",
  snapshot_deleted: "Snapshot delete failed",
};

/**
 * Sail reports an asynchronous snapshot-mutation failure on the same event type
 * as its success, with `data.error` carrying the reason — so the row label must
 * come from the event, not the registry alone, or a failed restore reads as
 * "Snapshot restored".
 */
function rowLabel(event: SailEvent, label: string): string {
  const failure = FAILURE_LABELS[event.type];
  return failure && dataString(event, "error") ? failure : label;
}

const CHAT_LANES = new Set(["room", "room-full", "invite", "invite-full"]);

/**
 * A chat or invite turn's clean exit is turn plumbing, not conversation — the
 * agent's reply is already in the room, so "agent stopped · exit 0" after every
 * turn manufactures the "it left" feeling. Failures render, loud.
 */
function cleanChatTurnStop(event: SailEvent): boolean {
  if (event.type !== "agent_session_stopped") return false;
  const role = event.data?.run_role;
  if (typeof role !== "string" || !CHAT_LANES.has(role)) return false;
  const exit = event.data?.exit_code;
  return exit === undefined || exit === null || exit === 0 || exit === "0";
}

function eventId(event: SailEvent): string {
  return event.id === undefined
    ? `${event.type}:${event.ts}:${event.agent}`
    : `event:${event.id}`;
}

function eventDecision(event: SailEvent): TimelineDecision {
  const reviewId = dataString(event, "review_id", "review") ?? "";
  const findingId = dataString(event, "finding_id", "finding");
  return {
    id: eventId(event),
    reviewId,
    ...(findingId ? { findingId } : {}),
    action: event.type === "finding_dismissed" ? "dismissed" : "approved",
    actor: event.agent,
    createdAt: event.ts,
  };
}

function overlayReviews(
  reviews: ReviewDetailResponse[],
  events: SailEvent[],
): ReviewDetailResponse[] {
  const overlays = new Map<string, SailEvent>();
  for (const event of events) {
    const rule = EVENT_REGISTRY[event.type];
    if (rule?.mode !== "overlay" || rule.target !== "review") continue;
    const reviewId = dataString(event, "review_id", "review");
    if (reviewId) overlays.set(reviewId, event);
  }
  return reviews.map((detail) => {
    const event = overlays.get(detail.review.id);
    if (!event) return detail;
    return {
      ...detail,
      review: {
        ...detail.review,
        status: "pending_decision",
        completed_at: event.ts,
      },
    };
  });
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

/**
 * The event's narration for a timeline row: the sail loop events carry their story in
 * `detail` (stage name, escalation reason), `findings` (severity counts), `reason`/`action`
 * (guardrail, stop nudge), and `error` (a failed async snapshot mutation). Empty string when
 * the event carries none of them.
 */
export function eventNarration(event: SailEvent): string {
  const { detail, findings, reason, action, label, error, agent, mode } = event.data ?? {};
  const counts =
    findings && typeof findings === "object"
      ? SEVERITY_ORDER.filter(
          (severity) => typeof (findings as Record<string, unknown>)[severity] === "number",
        )
          .map((severity) => `${(findings as Record<string, number>)[severity]} ${severity}`)
          .join(", ")
      : "";
  return [
    typeof agent === "string" && agent,
    typeof mode === "string" && mode,
    typeof label === "string" && label,
    typeof detail === "string" && detail,
    counts,
    typeof reason === "string" && reason,
    typeof action === "string" && action,
    typeof error === "string" && error,
  ]
    .filter(Boolean)
    .join(" · ");
}

function timestamp(item: TimelineItem): number {
  const parsed = Date.parse(item.occurredAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function calendarDay(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : `${parsed.getFullYear()}-${parsed.getMonth()}-${parsed.getDate()}`;
}

export function groupTimeline(
  items: TimelineItem[],
  windowMs = 5 * 60 * 1000,
): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const item of items) {
    if (item.kind !== "message") {
      groups.push(item);
      continue;
    }
    const previous = groups.at(-1);
    const previousMessage = previous?.kind === "message-group"
      ? previous.messages.at(-1)
      : undefined;
    const elapsed = previousMessage
      ? timestamp(item) - timestamp(previousMessage)
      : Number.POSITIVE_INFINITY;
    if (
      previous?.kind === "message-group" &&
      previous.author === item.message.author &&
      elapsed >= 0 &&
      elapsed <= windowMs &&
      calendarDay(previousMessage!.occurredAt) === calendarDay(item.occurredAt)
    ) {
      previous.messages.push(item);
      continue;
    }
    groups.push({
      kind: "message-group",
      id: `group:${item.id}`,
      occurredAt: item.occurredAt,
      author: item.message.author,
      messages: [item],
    });
  }
  return groups;
}

export function assembleTimeline({
  messages,
  events,
  reviews,
  runs,
  decisions = [],
}: {
  messages: RoomMessage[];
  events: SailEvent[];
  reviews: ReviewDetailResponse[];
  runs: RunView[];
  decisions?: TimelineDecision[];
}): TimelineItem[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const items: TimelineItem[] = messages.map((message) => ({
    kind: "message",
    id: `message:${message.id}`,
    occurredAt: message.created_at,
    message,
  }));

  for (const detail of overlayReviews(reviews, events)) {
    items.push({
      kind: "review",
      id: `review:${detail.review.id}`,
      occurredAt: detail.review.completed_at ?? detail.review.created_at,
      review: detail.review,
      findings: detail.findings,
    });
  }

  for (const event of events) {
    const rule = EVENT_REGISTRY[event.type];
    if (!rule) continue;
    if (rule.mode === "overlay" && rule.target === "lifecycle") {
      const covered = events.some((candidate) => {
        const candidateRule = EVENT_REGISTRY[candidate.type];
        return candidate !== event &&
          candidate.ts === event.ts &&
          candidateRule?.mode === "row" &&
          candidateRule.kind === "lifecycle";
      });
      if (!covered) {
        const to = dataString(event, "to", "status");
        items.push({
          kind: "lifecycle",
          id: eventId(event),
          occurredAt: event.ts,
          event,
          label: to ? `Status changed to ${to}` : "Status changed",
        });
      }
      continue;
    }
    if (rule.mode !== "row") continue;
    if (cleanChatTurnStop(event)) continue;
    if (rule.kind === "decision") {
      const decision = eventDecision(event);
      items.push({
        kind: "decision",
        id: decision.id,
        occurredAt: event.ts,
        decision,
      });
      continue;
    }
    const runId = dataString(event, "run_id", "run");
    items.push({
      kind: "lifecycle",
      id: eventId(event),
      occurredAt: event.ts,
      event,
      label: rowLabel(event, rule.label),
      ...(runId && runById.has(runId) ? { run: runById.get(runId) } : {}),
    });
  }

  for (const decision of decisions) {
    items.push({
      kind: "decision",
      id: decision.id,
      occurredAt: decision.createdAt,
      decision,
    });
  }

  return items.sort(
    (left, right) =>
      timestamp(left) - timestamp(right) ||
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.id.localeCompare(right.id),
  );
}

export function mergeMessages(
  existing: RoomMessage[],
  incoming: RoomMessage[],
): RoomMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (left, right) =>
      left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
  );
}

export type BufferedTail<T> = {
  visible: T[];
  buffered: T[];
};

export function bufferTail<T extends { id: string }>(
  state: BufferedTail<T>,
  arrivals: T[],
  atLatest: boolean,
): BufferedTail<T> {
  const seen = new Set([...state.visible, ...state.buffered].map((item) => item.id));
  const fresh = arrivals.filter((item) => !seen.has(item.id));
  return atLatest
    ? { visible: [...state.visible, ...fresh], buffered: state.buffered }
    : { visible: state.visible, buffered: [...state.buffered, ...fresh] };
}

export function releaseTail<T>(state: BufferedTail<T>): BufferedTail<T> {
  return { visible: [...state.visible, ...state.buffered], buffered: [] };
}
