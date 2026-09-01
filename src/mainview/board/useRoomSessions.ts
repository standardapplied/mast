import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  deckSessions,
  type SessionEntry,
  type SkewSide,
  skewOf,
} from "../terminal/roomDeck";
import { SessionStore, sessionStore } from "../terminal/sessionStore";

/**
 * One room's slice of the box's session inventory — a thin selector over the
 * app-wide {@link sessionStore} (wired to the gateway in App). Mounting and
 * unmounting are the room/route enter-and-leave reconcile points: each takes a
 * coalesced re-list, so a session created or killed on another surface reaches
 * this one even with the event lane fully dead.
 */
export function useRoomSessions(
  roomId: string,
  store: SessionStore = sessionStore,
): {
  /** Null until the first listing lands. */
  sessions: SessionEntry[] | null;
  skew: SkewSide | null;
  /** Ended reasons by session: death records first, event history second. */
  reasons: Record<string, string>;
  refresh: () => void;
} {
  const version = useSyncExternalStore(store.subscribe, () => store.version);

  useEffect(() => {
    store.ensureHistory(roomId);
    store.refresh();
    return () => store.refresh();
  }, [store, roomId]);

  return useMemo(() => {
    const all = store.sessions();
    return {
      sessions: all === null ? null : deckSessions(all, roomId),
      skew: skewOf(store.skewReason() ?? undefined),
      reasons: store.reasons(),
      refresh: () => store.refresh(),
    };
    // version is the store's change signal; the selectors read fresh state through it.
  }, [store, roomId, version]);
}
