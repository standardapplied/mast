import type { SpecStatus } from "../../shared/sail-models";
import type { BadgeTone } from "../components/ui";

export const BOARD_COLUMNS: readonly SpecStatus[] = [
  "draft",
  "pending",
  "in_progress",
  "review",
  "awaiting_merge",
  "done",
  "cancelled",
];

export const STATUS_LABEL: Record<SpecStatus, string> = {
  draft: "Draft",
  pending: "Pending",
  in_progress: "In progress",
  review: "Review",
  awaiting_merge: "Awaiting merge",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

export const STATUS_TONE: Record<SpecStatus, BadgeTone> = {
  draft: "neutral",
  pending: "neutral",
  in_progress: "accent",
  review: "warning",
  awaiting_merge: "info",
  done: "success",
  cancelled: "neutral",
  archived: "neutral",
};

/**
 * Skew-safe lookups: an older Mast meeting a newer sail can receive a status
 * string it doesn't know, which must render (raw, neutral) rather than crash.
 */
export function statusLabel(status: SpecStatus | string): string {
  return STATUS_LABEL[status as SpecStatus] ?? status;
}

export function statusTone(status: SpecStatus | string): BadgeTone {
  return STATUS_TONE[status as SpecStatus] ?? "neutral";
}

const ORDER: readonly SpecStatus[] = [
  "draft",
  "pending",
  "in_progress",
  "review",
  "awaiting_merge",
  "done",
];

/**
 * Legal drag transitions: one step forward, one step back, archive from
 * anywhere, unarchive back to draft. Everything else is blocked in the UI —
 * multi-stage jumps stay the lifecycle's (sail's) job, and `cancelled` is
 * only ever entered by sail's clean stop, never by a drag.
 */
export function canTransition(from: SpecStatus, to: SpecStatus): boolean {
  if (from === to) return false;
  if (to === "archived") return true;
  if (from === "archived") return to === "draft";
  const fromIndex = ORDER.indexOf(from);
  const toIndex = ORDER.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return false;
  return Math.abs(fromIndex - toIndex) === 1;
}
