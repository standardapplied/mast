import { useEffect, useState } from "react";
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
 * is (the observer banner's "me"), and the dispatch probes that gate a yielded
 * corpse's Reopen — an unanswered or failed lookup keeps Reopen withheld, because
 * reopening over a dispatch we merely failed to see puts two agents on one checkout.
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
  const [dispatchLive, setDispatchLive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    void gateway.whoami().then((r) => {
      if (alive && r.ok) setMe(r.value.fde);
    });
    return () => {
      alive = false;
    };
  }, [gateway]);

  useEffect(() => {
    if (!sessions) return;
    let alive = true;
    const specIds = new Set(
      sessions
        .filter((s) => !s.live)
        .map((s) => yieldedDispatch(reasons[s.name])?.specId)
        .filter((id): id is string => !!id),
    );
    for (const specId of specIds) {
      void gateway.listRuns(specId).then((r) => {
        if (!alive || !r.ok) return;
        const running = r.value.runs.some((run) => run.status === "running");
        setDispatchLive((current) =>
          current[specId] === running ? current : { ...current, [specId]: running },
        );
      });
    }
    return () => {
      alive = false;
    };
  }, [gateway, sessions, reasons]);

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
