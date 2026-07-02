import type { SpecStatus } from "../../shared/sail-models";

export const BOARD_COLUMNS: readonly SpecStatus[] = [
  "draft",
  "pending",
  "in_progress",
  "review",
  "awaiting_merge",
  "done",
];

export const STATUS_LABEL: Record<SpecStatus, string> = {
  draft: "Draft",
  pending: "Pending",
  in_progress: "In progress",
  review: "Review",
  awaiting_merge: "Awaiting merge",
  done: "Done",
  archived: "Archived",
};

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
 * multi-stage jumps stay the lifecycle's (sail's) job.
 */
export function canTransition(from: SpecStatus, to: SpecStatus): boolean {
  if (from === to) return false;
  if (to === "archived") return true;
  if (from === "archived") return to === "draft";
  const fromIndex = ORDER.indexOf(from);
  const toIndex = ORDER.indexOf(to);
  return Math.abs(fromIndex - toIndex) === 1;
}
