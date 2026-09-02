import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catalogStore, connectCatalog } from "../board/catalogStore";
import { DeckSkewCard } from "../board/RoomDeck";
import { useRoomSessions } from "../board/useRoomSessions";
import { LoadingMark } from "../components/Loading";
import {
  type DeckServices,
  type RoomWorkbenchProps,
  yieldedDispatch,
} from "../terminal/roomDeck";
import { TerminalPanes } from "./TerminalPanes";
import { TerminalSplit } from "./TerminalSplit";

/**
 * The room route's body: the Terminal view's whole workbench — the splittable pane
 * host inside the files/viewer/drag-drop split — scoped to one room. The workbench
 * owns the room's data: the live session listing with ended reasons, who the caller
 * is (the observer banner's "me"), and the dispatch gate on a yielded corpse's
 * Reopen — an unanswered or failed lookup keeps Reopen withheld, because reopening
 * over a dispatch we merely failed to see puts two agents on one checkout. The run
 * lists behind that gate are retained in the catalog store, which refreshes them on
 * run events and retries a failed lookup at every reconcile point — the gate fails
 * closed, never silent-forever.
 */
export function RoomWorkbench({
  gateway,
  roomId,
  project,
  active,
  focus,
  launch,
}: RoomWorkbenchProps) {
  const { sessions, skew, reasons, refresh } = useRoomSessions(roomId);
  const [me, setMe] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void gateway.whoami().then((r) => {
      if (alive && r.ok) setMe(r.value.fde);
    });
    return () => {
      alive = false;
    };
  }, [gateway]);

  useEffect(() => connectCatalog(gateway), [gateway]);
  const catalogVersion = useSyncExternalStore(catalogStore.subscribe, () => catalogStore.version);

  const yieldedSpecIds = useMemo(
    () =>
      [
        ...new Set(
          (sessions ?? [])
            .filter((s) => !s.live)
            .map((s) => yieldedDispatch(reasons[s.name])?.specId)
            .filter((id): id is string => !!id),
        ),
      ].sort(),
    [sessions, reasons],
  );
  const yieldedKey = yieldedSpecIds.join(",");

  useEffect(() => {
    const releases = yieldedSpecIds.map((specId) => catalogStore.retainRuns(specId));
    return () => releases.forEach((release) => release());
    // yieldedKey names the same ids the memo above derived; the array identity churns.
  }, [yieldedKey]);

  const dispatchLive = useMemo(() => {
    const live: Record<string, boolean> = {};
    for (const specId of yieldedSpecIds) {
      const runs = catalogStore.runsOf(specId);
      if (runs) live[specId] = runs.some((run) => run.status === "running");
    }
    return live;
    // catalogVersion is the store's change signal; runsOf reads fresh through it.
  }, [yieldedSpecIds, catalogVersion]);

  if (sessions === null) {
    return (
      <div className="room-workbench-gate">
        {skew ? <DeckSkewCard side={skew} /> : <LoadingMark label="Terminals" />}
      </div>
    );
  }

  return (
    <TerminalSplit
      target={project}
      active={active}
      terminal={(ref) => (
        <TerminalPanes
          ref={ref}
          active={active}
          room={{
            roomId,
            project,
            sessions,
            reasons,
            dispatchLive,
            me,
            focus,
            launch,
            refresh,
          }}
        />
      )}
    />
  );
}

export const tauriDeckServices: DeckServices = { Workbench: RoomWorkbench };
