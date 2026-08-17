import type { SailEvent, SnapshotView } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import type { BadgeTone } from "../components/ui";

/**
 * Pure snapshot-panel logic: source badge tones, verbatim refusal prose, and
 * the reduction of stream events onto a pending mutation. Transport-free so the
 * panel's behavior is testable without the Tauri bridge.
 */

export type SnapshotMutation = { name: string; action: "restore" | "delete" };

export function sourceTone(source: string): BadgeTone {
  switch (source) {
    case "invite":
      return "info";
    case "guardrail":
      return "warning";
    case "dispatch":
      return "neutral";
    default:
      return "accent";
  }
}

/** A server refusal rendered verbatim: its message plus its action, never a local guess. */
export function refusalDetail(error: SailWireError): string {
  return `${error.message}${error.action ? ` — ${error.action}` : ""}`;
}

export function sortNewestFirst(snapshots: SnapshotView[]): SnapshotView[] {
  return [...snapshots].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export type SnapshotEventOutcome =
  | { kind: "resolved"; action: "restore" | "delete"; name: string; error?: string }
  | { kind: "refresh" }
  | null;

/**
 * What a stream event means for this project's panel: the completion (or
 * failure, via `data.error`) of the pending mutation, a list refresh for any
 * other snapshot activity, or nothing for foreign projects.
 */
export function snapshotEventOutcome(
  event: SailEvent,
  project: string,
  pending: SnapshotMutation | null,
): SnapshotEventOutcome {
  if (event.project !== project) return null;
  if (event.type === "snapshot_created") return { kind: "refresh" };
  if (event.type !== "snapshot_restored" && event.type !== "snapshot_deleted") return null;
  const label = typeof event.data?.label === "string" ? event.data.label : undefined;
  const action = event.type === "snapshot_restored" ? "restore" : "delete";
  if (!pending || label !== pending.name || action !== pending.action) return { kind: "refresh" };
  const error = typeof event.data?.error === "string" ? event.data.error : undefined;
  return { kind: "resolved", action, name: pending.name, error };
}
