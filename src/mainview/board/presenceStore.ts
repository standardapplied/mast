import type { RunPresence, RunView, SailEvent } from "../../shared/sail-models";
import type { Gateway } from "../gateway";

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

/** Chat lanes: an engaged agent's turn or a wake, either mode. */
export function chatLaneRole(role: string | undefined): boolean {
  return role === "room" || role === "room-full";
}

type Entry = {
  lastActivityAt: number | null;
  role?: string;
  /** A server-declared quiet overrides the local clock until activity resumes —
   *  the server judged staleness against its own stamp, ours may be skewed. */
  quiet: boolean;
};

/** Entries keyed by run id ("?" for events that carry none) so two concurrent
 *  runs — a build and a chat turn — never collapse into one chip and one run's
 *  exit never wipes the other's presence. */
type SpecEntries = Map<string, Entry>;

function parseTs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export class PresenceStore {
  /** Bumped on every observable change so `useSyncExternalStore` can read it. */
  version = 0;

  private entries = new Map<string, SpecEntries>();
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
    const before = this.entries.size;
    this.entries = new Map();
    for (const run of runs) {
      if (!run.spec_id) continue;
      // Only a run that actually carries presence seeds an entry: a live stamp,
      // or the server's own quiet verdict. A running run with neither — a review
      // or fix run, which is event-silent by design (no SAIL_SPEC_ID, so its
      // hooks never stamp) — has no presence and no lifecycle event will ever
      // clear it, so it must not leave a lingering entry here.
      const stamp = parseTs(run.last_activity_at);
      const hasPresence = stamp !== null || run.presence === "quiet";
      if (run.status !== "running" || !hasPresence) continue;
      const bySpec = this.entries.get(run.spec_id) ?? new Map<string, Entry>();
      bySpec.set(run.id, {
        lastActivityAt: stamp,
        role: run.role,
        quiet: run.presence === "quiet",
      });
      this.entries.set(run.spec_id, bySpec);
    }
    if (before > 0 || this.entries.size > 0) this.emit();
  }

  private runKey(event: SailEvent): string {
    const runId = event.data?.run_id;
    return typeof runId === "string" && runId ? runId : "?";
  }

  /** Folds one SSE event in; anything without a spec or outside the vocabulary is ignored. */
  noteEvent(event: SailEvent): void {
    const specId = event.spec;
    if (!specId) return;
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      this.noteProgress(specId, event, parseTs(event.ts) ?? Date.now());
      return;
    }
    if (event.type === "agent_presence") {
      this.notePresence(specId, event);
      return;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      const bySpec = this.entries.get(specId);
      if (!bySpec) return;
      const key = this.runKey(event);
      // A terminal event addressing a known run clears exactly that run; a
      // role-less legacy stop (no run_id) keeps the old clear-the-spec behavior.
      const changed = key === "?" ? bySpec.size > 0 : bySpec.delete(key);
      if (key === "?") bySpec.clear();
      if (bySpec.size === 0) this.entries.delete(specId);
      if (changed) this.emit();
    }
  }

  private noteProgress(specId: string, event: SailEvent, at: number): void {
    const bySpec = this.entries.get(specId) ?? new Map<string, Entry>();
    const key = this.runKey(event);
    const entry = bySpec.get(key);
    if (entry && !entry.quiet) {
      const fresh =
        entry.lastActivityAt !== null && at - entry.lastActivityAt < PRESENCE_THRESHOLD_MS;
      entry.lastActivityAt = Math.max(entry.lastActivityAt ?? at, at);
      if (fresh) return;
    } else {
      bySpec.set(key, { lastActivityAt: at, role: entry?.role, quiet: false });
      this.entries.set(specId, bySpec);
    }
    this.emit();
  }

  private notePresence(specId: string, event: SailEvent): void {
    const state = event.data?.presence;
    if (state !== "working" && state !== "quiet") return;
    const bySpec = this.entries.get(specId) ?? new Map<string, Entry>();
    const key = this.runKey(event);
    const entry = bySpec.get(key);
    const role = typeof event.data?.run_role === "string" ? event.data.run_role : entry?.role;
    const at =
      parseTs(event.data?.last_activity_at) ??
      (state === "working" ? parseTs(event.ts) : entry?.lastActivityAt ?? null);
    bySpec.set(key, { lastActivityAt: at, role, quiet: state === "quiet" });
    this.entries.set(specId, bySpec);
    this.emit();
  }

  private presence(entry: Entry, now: number): SpecPresence | null {
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

  /**
   * The spec's headline presence against `now` — the working lane when one is
   * live (the board's semantics), else the chat lane's. Null when nothing is.
   */
  presenceOf(specId: string, now: number): SpecPresence | null {
    const bySpec = this.entries.get(specId);
    if (!bySpec) return null;
    let chat: SpecPresence | null = null;
    for (const entry of bySpec.values()) {
      const presence = this.presence(entry, now);
      if (!presence) continue;
      if (!chatLaneRole(entry.role)) return presence;
      chat = chat ?? presence;
    }
    return chat;
  }

  /** The engaged agent's own presence: the chat-lane entry, when one is live. */
  chatPresenceOf(specId: string, now: number): SpecPresence | null {
    const bySpec = this.entries.get(specId);
    if (!bySpec) return null;
    for (const entry of bySpec.values()) {
      if (!chatLaneRole(entry.role)) continue;
      const presence = this.presence(entry, now);
      if (presence) return presence;
    }
    return null;
  }
}

/** The app-wide instance; wired to the gateway's event stream in App. */
export const presenceStore = new PresenceStore();

/**
 * Seeds `store` from one runs snapshot, then lets the live stream drive it.
 * Subscribing is synchronous but the snapshot fetch is not, so a lifecycle
 * event that lands mid-fetch is buffered and replayed *after* the seed — a run
 * that goes terminal while the snapshot is in flight is never resurrected by
 * the stale run rows it was read before. Returns the unsubscribe.
 */
export function connectPresence(
  gateway: Pick<Gateway, "listRuns" | "onEvent">,
  store: PresenceStore,
): () => void {
  let seeded = false;
  const pending: SailEvent[] = [];
  const unsubscribe = gateway.onEvent((event) => {
    if (seeded) store.noteEvent(event);
    else pending.push(event);
  });
  void gateway.listRuns().then((result) => {
    if (result.ok && Array.isArray(result.value.runs)) store.noteRuns(result.value.runs);
    seeded = true;
    for (const event of pending) store.noteEvent(event);
    pending.length = 0;
  });
  return unsubscribe;
}
