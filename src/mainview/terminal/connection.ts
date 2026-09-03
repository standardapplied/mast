/**
 * Connection lifecycle policy for a durable terminal session — pure logic, no timers or transport.
 *
 * A session ends for one of two reasons, and they demand opposite UX: the link died (laptop lid,
 * network change, SSH keepalive timeout) while the host session lives on — reconnect, automatically;
 * or the shell itself exited — the session is gone, offer a restart. {@link classifyEnd} tells them
 * apart from the exit reason, and {@link Reconnector} paces the automatic retries: exponential
 * backoff while the link stays bad, reset once a connection has proven stable.
 */

/** How long a connection must hold before a new drop restarts the backoff ladder from the bottom. */
export const STABLE_MS = 10_000;

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000] as const;

/**
 * Why an attach is over: `transport` — the link died, the host session lives, auto-reattach;
 * `ended` — the shell itself exited, offer a restart; `refused` — the host said no (foreign
 * session, bad token, dead container), where retrying the same request can only fail the same way.
 */
export type ExitClass = "transport" | "ended" | "refused";

export interface SessionEnd {
  readonly klass: ExitClass;
  readonly reason: string;
}

/**
 * What a session pane is doing right now, for the pane overlay and the tab-bar status cluster.
 * `connecting.retrying` separates a first attach (quiet) from a reconnect in flight (surfaced).
 */
export type SessionStatus =
  | { kind: "connecting"; retrying: boolean }
  | { kind: "up" }
  | { kind: "down"; reason: string }
  | { kind: "ended"; reason: string }
  | { kind: "failed"; reason: string };

const EXIT_CLASSES: ReadonlySet<string> = new Set(["transport", "ended", "refused"]);

/**
 * Decodes the `session://exit` payload — `{class, reason}` as the Rust side emits it. Anything
 * malformed reads as a transport drop: the retryable default, since a wrongly-parked pane strands
 * the user while a wrongly-retried one merely backs off.
 */
export function toSessionEnd(payload: unknown): SessionEnd {
  if (payload !== null && typeof payload === "object") {
    const { class: klass, reason } = payload as { class?: unknown; reason?: unknown };
    if (typeof klass === "string" && EXIT_CLASSES.has(klass)) {
      return { klass: klass as ExitClass, reason: typeof reason === "string" ? reason : "" };
    }
  }
  return { klass: "transport", reason: String(payload) };
}

/** Whether a status deserves a warning marker in chrome (tab dots, chips). A quiet first connect doesn't. */
export function isUnwell(status: SessionStatus): boolean {
  return status.kind !== "up" && !(status.kind === "connecting" && !status.retrying);
}

/** Structural equality — {@link worstStatus} mints fresh objects, so identity checks misfire. */
export function statusEqual(a: SessionStatus, b: SessionStatus): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "up":
      return true;
    case "connecting":
      return a.retrying === (b as typeof a).retrying;
    default:
      return a.reason === (b as typeof a).reason;
  }
}

/** Higher = more broken. Ordering: up < connecting < reconnecting < ended < down < failed. */
function severity(status: SessionStatus): number {
  switch (status.kind) {
    case "up":
      return 0;
    case "connecting":
      return status.retrying ? 2 : 1;
    case "ended":
      return 3;
    case "down":
      return 4;
    case "failed":
      return 5;
  }
}

/**
 * The status a multi-pane tab reports upward: its most broken pane, so the tab bar's cluster and
 * dot surface trouble anywhere in the tab. An empty tab has no status to report — null.
 */
export function worstStatus(statuses: readonly SessionStatus[]): SessionStatus | null {
  let worst: SessionStatus | null = null;
  let max = -1;
  for (const s of statuses) {
    const sev = severity(s);
    if (sev > max) {
      max = sev;
      worst = s;
    }
  }
  return worst;
}

/**
 * Paces reconnect attempts. Call {@link opened} when an attach succeeds, {@link lost} when the
 * transport drops (it returns how long to wait before the next attempt), and {@link reset} on a
 * manual reconnect so the user's click is never delayed by earlier failures.
 */
export class Reconnector {
  private attempt = 0;
  private connectedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  opened(): void {
    this.connectedAt = this.now();
  }

  /** The transport dropped; returns the delay in ms before the next automatic attempt. */
  lost(): number {
    if (this.connectedAt !== null && this.now() - this.connectedAt >= STABLE_MS) {
      this.attempt = 0;
    }
    this.connectedAt = null;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
    this.connectedAt = null;
  }
}

/** What an absent session's ended card can say when the host is up but does not list it. */
export const NOT_RUNNING = "not running";

/** What it can say when the host's boot id changed since the session was last seen. */
export const HOST_RESTARTED = "host restarted";

/**
 * Explains an absence from what the client can prove: a session last seen under one host boot and
 * absent under a different one was lost to a restart; with no boot change to point at (or no
 * memory of one), all the client knows is that it is not running.
 */
export function absenceReason(
  seenUnder: string | null | undefined,
  hostBootId: string | null | undefined,
): string {
  return seenUnder && hostBootId && seenUnder !== hostBootId ? HOST_RESTARTED : NOT_RUNNING;
}

/** The pty host's listing as the transport edge sees it: the boot id it answered under and its sessions. */
export interface HostListing {
  readonly hostBootId: string;
  readonly sessions: ReadonlyArray<{ readonly name: string; readonly live: boolean }>;
}

/**
 * Settles a transport drop against ONE reconcile listing before any backoff: the session listed
 * live is a genuine link loss (reconnect); listed dead, it ended; absent, it is not running — or
 * the host restarted, when the boot id says so. An unreachable listing (`null`) means the link
 * itself is down, which is exactly what the reconnect path is for. Non-transport endings pass
 * through untouched.
 */
export function resolveTransportEnd(
  end: SessionEnd,
  session: string,
  seenUnder: string | null,
  listing: HostListing | null,
): SessionEnd {
  if (end.klass !== "transport" || listing === null) return end;
  const listed = listing.sessions.find((s) => s.name === session);
  if (listed?.live) return end;
  if (listed) return { klass: "ended", reason: "ended" };
  return { klass: "ended", reason: absenceReason(seenUnder, listing.hostBootId) };
}
