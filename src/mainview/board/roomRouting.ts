import type { SailEvent } from "../../shared/sail-models";

/**
 * Event→fetch routing for the spec room: each live event refreshes only the
 * state it names, instead of ringing a doorbell that reloads the world. The
 * fetches themselves are idempotent reads, so convergence never depends on
 * event order — and anything outside the vocabulary falls back to the old
 * conservative refresh so a new server event type is never silently dropped.
 */

/** High-volume liveness signals: they feed the presence store (wired app-wide)
 *  and are not timeline rows, so the room ignores them entirely — zero fetches,
 *  zero merges, zero renders during a live run's tool storm. */
const TELEMETRY_EVENT_TYPES = new Set([
  "agent_tool_started",
  "agent_tool_finished",
  "agent_log_chunk",
  "agent_presence",
  "heartbeat",
]);

export function isTelemetryEvent(type: string): boolean {
  return TELEMETRY_EVENT_TYPES.has(type);
}

export type RoomRefresh =
  | { kind: "none" }
  | { kind: "messages" }
  | { kind: "review-detail"; reviewId: string }
  | { kind: "reviews" }
  | { kind: "runs" }
  | { kind: "fallback" };

/** Review events whose sail payload may carry the review id; with it the room
 *  refreshes that one detail, without it the review list for the spec. */
const REVIEW_DETAIL_TYPES = new Set([
  "review_approved",
  "finding_dismissed",
  "review_stage_started",
  "review_stage_passed",
  "review_stage_failed",
  "review_errored",
  "review_escalated",
  "review_pipeline_error",
]);

/** Boundaries that change the review list's shape, not just one detail. */
const REVIEW_LIST_TYPES = new Set(["review_iteration_started", "review_completed"]);

const RUN_LIFECYCLE_TYPES = new Set([
  "spec_dispatched",
  "spec_restarted",
  "agent_session_started",
  "agent_session_stopped",
  "agent_session_completed",
  "agent_stopped",
  "agent_failed",
  "agent_cancelled",
]);

/** Rows that tell their whole story from the event payload — nothing to fetch. */
const SELF_CONTAINED_TYPES = new Set([
  "spec_status_changed",
  "board_updated",
  "spec_failed",
  "spec_cancelled",
  "spec_stranded",
  "agent_stop_nudged",
  "guardrail_triggered",
  "snapshot_created",
  "snapshot_restored",
  "snapshot_deleted",
]);

export function roomRefreshFor(event: SailEvent): RoomRefresh {
  const { type } = event;
  if (isTelemetryEvent(type) || SELF_CONTAINED_TYPES.has(type)) return { kind: "none" };
  if (type === "spec_message_posted") return { kind: "messages" };
  if (REVIEW_DETAIL_TYPES.has(type)) {
    const reviewId = event.data?.review_id ?? event.data?.review;
    return typeof reviewId === "string" && reviewId
      ? { kind: "review-detail", reviewId }
      : { kind: "reviews" };
  }
  if (REVIEW_LIST_TYPES.has(type)) return { kind: "reviews" };
  if (RUN_LIFECYCLE_TYPES.has(type)) return { kind: "runs" };
  return { kind: "fallback" };
}

/**
 * Collapses an event burst into one run of `fetch`: calls within the same
 * microtask batch share one run, and calls landing while a run is in flight
 * mark it dirty so it re-runs exactly once after — the `useBoard` pattern,
 * extended to cover the in-flight window.
 */
export function coalesce(fetch: () => Promise<unknown>): () => void {
  let queued = false;
  let inFlight = false;
  let dirty = false;
  const fire = async () => {
    queued = false;
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      await fetch();
    } catch {
      // A failed refresh must not wedge the coalescer; the fetch reports its own errors.
    } finally {
      inFlight = false;
      if (dirty) {
        dirty = false;
        kick();
      }
    }
  };
  const kick = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => void fire());
  };
  return kick;
}
