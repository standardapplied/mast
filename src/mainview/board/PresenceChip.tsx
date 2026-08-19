import { useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { relativeTime } from "./rooms";
import { presenceStore, type PresenceStore } from "./presenceStore";

/**
 * The liveness chip for a spec's live run: a pulsing "working" while the agent
 * shows progress, "quiet (3m)" once it has gone silent past the presence
 * threshold. Renders nothing when the spec has no live run or its run predates
 * activity stamping — the plain status is shown instead of a guess. A slow
 * local tick re-evaluates against the clock, so the quiet flip happens even if
 * the server's transition event was missed; non-build lanes are labeled by
 * their run role.
 */

const CLOCK_TICK_MS = 30_000;

export function PresenceChip({
  specId,
  verbose = false,
  store = presenceStore,
  now = Date.now,
}: {
  specId: string;
  /** Header mode: spell the working state out ("An agent is on it") rather than
   *  the terse card label. */
  verbose?: boolean;
  store?: PresenceStore;
  now?: () => number;
}) {
  const version = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.version,
  );
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(bump, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const presence = useMemo(
    () => store.presenceOf(specId, now()),
    [store, specId, now, version, tick],
  );
  if (!presence) return null;

  const roleLabel = presence.role && presence.role !== "build" ? presence.role : null;
  const elapsed =
    presence.state === "quiet" && presence.lastActivityAt !== null
      ? relativeTime(new Date(presence.lastActivityAt).toISOString(), now())
      : null;
  const label = verbose
    ? presence.state === "working"
      ? "An agent is on it"
      : "Idle"
    : roleLabel
      ? `${roleLabel} ${presence.state}`
      : presence.state;
  return (
    <span
      className={`presence-chip is-${presence.state}`}
      data-testid={`presence-${specId}`}
      title={
        presence.state === "working"
          ? "The agent is actively working — tool calls are flowing."
          : "No agent activity past the presence threshold."
      }
    >
      <span className="presence-dot" />
      <span className="presence-chip__label">{label}</span>
      {elapsed && <span className="presence-chip__elapsed">{elapsed}</span>}
    </span>
  );
}
