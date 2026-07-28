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
  review_completed: { mode: "overlay", target: "review" },
  review_failed: { mode: "overlay", target: "review" },
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
        status: event.type === "review_failed" ? "failed" : "pending_decision",
        completed_at: event.ts,
      },
    };
  });
}

function timestamp(item: TimelineItem): number {
  const parsed = Date.parse(item.occurredAt);
  return Number.isNaN(parsed) ? 0 : parsed;
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
    if (!rule || rule.mode !== "row") continue;
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
      label: rule.label,
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
