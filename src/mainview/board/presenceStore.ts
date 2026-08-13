import type { RunPresence, RunView, SailEvent } from "../../shared/sail-models";

/**
 * Per-spec agent presence, derived — never stored durably — from two feeds:
 * runs data on load (`last_activity_at` + the server's read-time `presence`)
 * and the live SSE lane (`agent_tool_*` progress events and the server's
 * `agent_presence` transitions). Framework-free like FileTreeStore/ViewerStore;
 * components subscribe via `useSyncExternalStore` and read `presenceOf` with
 * their own clock, so a run that goes silent flips to quiet client-side even
 * if the transition event was missed. Progress bursts inside the freshness
 * window mutate the timestamp without notifying, so a chunk stream never
 * causes a render per chunk.
 */

/** Mirrors the server's RunPresence.THRESHOLD — quiet begins past this. */
export const PRESENCE_THRESHOLD_MS = 120_000;

const PROGRESS_EVENT_TYPES = new Set([
  "agent_tool_started",
  "agent_tool_finished",
  "agent_log_chunk",
]);

const TERMINAL_EVENT_TYPES = new Set([
  "agent_session_stopped",
  "agent_session_completed",
  "agent_cancelled",
  "agent_failed",
]);

export type SpecPresence = {
  state: RunPresence;
  /** Epoch ms of the last observed activity; null when only the state is known. */
  lastActivityAt: number | null;
  /** The live run's role when known ("build", "review", …); undefined from bare progress events. */
  role?: string;
};

type Entry = {
  lastActivityAt: number | null;
  role?: string;
  /** A server-declared quiet overrides the local clock until activity resumes —
   *  the server judged staleness against its own stamp, ours may be skewed. */
  quiet: boolean;
};

function parseTs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export class PresenceStore {
  /** Bumped on every observable change so `useSyncExternalStore` can read it. */
  version = 0;

  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Derives presence from a runs listing: each spec's newest run decides —
   * a running one seeds the entry, a terminal one clears it. Runs without a
   * spec (ad-hoc sessions) have no card or room and are ignored.
   */
  noteRuns(runs: readonly RunView[]): void {
    const newest = new Map<string, RunView>();
    for (const run of runs) {
      if (!run.spec_id) continue;
      const current = newest.get(run.spec_id);
      if (!current || run.started_at.localeCompare(current.started_at) > 0) {
        newest.set(run.spec_id, run);
      }
    }
    let changed = false;
    for (const [specId, run] of newest) {
      if (run.status !== "running") {
        changed = this.entries.delete(specId) || changed;
        continue;
      }
      this.entries.set(specId, {
        lastActivityAt: parseTs(run.last_activity_at),
        role: run.role,
        quiet: run.presence === "quiet",
      });
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Folds one SSE event in; anything without a spec or outside the vocabulary is ignored. */
  noteEvent(event: SailEvent): void {
    const specId = event.spec;
    if (!specId) return;
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      this.noteProgress(specId, parseTs(event.ts) ?? Date.now());
      return;
    }
    if (event.type === "agent_presence") {
      this.notePresence(specId, event);
      return;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type) && this.entries.delete(specId)) {
      this.emit();
    }
  }

  private noteProgress(specId: string, at: number): void {
    const entry = this.entries.get(specId);
    if (entry && !entry.quiet) {
      const fresh =
        entry.lastActivityAt !== null && at - entry.lastActivityAt < PRESENCE_THRESHOLD_MS;
      entry.lastActivityAt = Math.max(entry.lastActivityAt ?? at, at);
      if (fresh) return;
    } else {
      this.entries.set(specId, { lastActivityAt: at, role: entry?.role, quiet: false });
    }
    this.emit();
  }

  private notePresence(specId: string, event: SailEvent): void {
    const state = event.data?.presence;
    if (state !== "working" && state !== "quiet") return;
    const entry = this.entries.get(specId);
    const role = typeof event.data?.run_role === "string" ? event.data.run_role : entry?.role;
    const at =
      parseTs(event.data?.last_activity_at) ??
      (state === "working" ? parseTs(event.ts) : entry?.lastActivityAt ?? null);
    this.entries.set(specId, { lastActivityAt: at, role, quiet: state === "quiet" });
    this.emit();
  }

  /** The spec's presence against `now`, or null when its live run has none. */
  presenceOf(specId: string, now: number): SpecPresence | null {
    const entry = this.entries.get(specId);
    if (!entry) return null;
    if (entry.quiet) {
      return { state: "quiet", lastActivityAt: entry.lastActivityAt, role: entry.role };
    }
    if (entry.lastActivityAt === null) return null;
    return {
      state: now - entry.lastActivityAt > PRESENCE_THRESHOLD_MS ? "quiet" : "working",
      lastActivityAt: entry.lastActivityAt,
      role: entry.role,
    };
  }
}

/** The app-wide instance; wired to the gateway's event stream in App. */
export const presenceStore = new PresenceStore();
