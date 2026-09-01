import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SailEvent } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import {
  type DeckSession,
  deckSessions,
  endedReasons,
  isDeckEvent,
  type SkewSide,
  skewOf,
} from "../terminal/roomDeck";
import { coalesce } from "./roomRouting";

/**
 * One room's slice of the host's pty inventory, kept live: the listing refreshes
 * on the room's pty events and on reconnect (coalesced — an observer storm never
 * turns into a listing per event), and the room's event history supplies each
 * corpse's ended reason. Shared by the header's deck cards and the terminal
 * route's workbench.
 */
export function useRoomSessions(
  gateway: Gateway,
  roomId: string,
): {
  /** Null until the first listing lands. */
  sessions: DeckSession[] | null;
  skew: SkewSide | null;
  /** Ended reasons by session, from the room's pty event history. */
  reasons: Record<string, string>;
  refresh: () => void;
} {
  const [sessions, setSessions] = useState<DeckSession[] | null>(null);
  const [skewReason, setSkewReason] = useState<string | null>(null);
  const [events, setEvents] = useState<SailEvent[]>([]);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const result = await gateway.listSessions();
    if (!alive.current) return;
    if (result.ok) {
      setSessions(deckSessions(result.value, roomId));
      setSkewReason(null);
    } else {
      setSkewReason(result.error.message);
    }
  }, [gateway, roomId]);

  const refresh = useMemo(() => coalesce(load), [load]);

  useEffect(() => {
    refresh();
    void gateway.specEvents(roomId).then((r) => {
      if (alive.current && r.ok) setEvents(r.value.events);
    });
  }, [gateway, roomId, refresh]);

  useEffect(
    () =>
      gateway.onEvent((event) => {
        if (!isDeckEvent(event, roomId)) return;
        setEvents((current) => [...current, event]);
        refresh();
      }),
    [gateway, roomId, refresh],
  );

  useEffect(
    () =>
      gateway.onConnectionStatus((status) => {
        if (status.phase === "ready") refresh();
      }),
    [gateway, refresh],
  );

  const reasons = useMemo(() => endedReasons(events), [events]);
  return { sessions, skew: skewOf(skewReason ?? undefined), reasons, refresh };
}
