import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SailEvent } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { shortTitle } from "../terminal/paneLayout";
import {
  commandFor,
  type DeckGlyph,
  type DeckServices,
  type DeckSession,
  deckSessions,
  endedReasons,
  isDeckEvent,
  nextRoomSession,
  skewOf,
  yieldedDispatch,
} from "../terminal/roomDeck";
import { coalesce } from "./roomRouting";
import { DeckAttachUnavailable, DeckEndedCard, DeckStrip } from "./RoomDeck";

/**
 * The room deck: the strip of this room's live pty sessions at the top of the room
 * pane, terminals attaching in place of the conversation, and the corpse cards. Data
 * comes from the gateway's session listing (refreshed on the room's pty events and on
 * reconnect); attaching is the injected Tauri terminal — absent in the browser preview,
 * where chips render and attach explains itself.
 *
 * Opened terminals stay mounted (hidden) once visited so switching between the
 * conversation and a session never detaches it — the app's keep-mounted law.
 */

type OpenedTerminal = {
  readonly command: string[];
  readonly killFirst?: boolean;
};

export function RoomDeckPanel({
  gateway,
  roomId,
  project,
  services,
  active = true,
  children,
}: {
  gateway: Gateway;
  roomId: string;
  project: string;
  /** The Tauri terminal edge; absent in demo/tests, where chips are data only. */
  services?: DeckServices;
  /** False while the room is hidden — parks terminal focus and drawing. */
  active?: boolean;
  /** The conversation this deck sits above. */
  children: ReactNode;
}) {
  const [sessions, setSessions] = useState<DeckSession[]>([]);
  const [skewReason, setSkewReason] = useState<string | null>(null);
  const [events, setEvents] = useState<SailEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlyMap<string, OpenedTerminal>>(new Map());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState<DeckSession | null>(null);
  const [me, setMe] = useState<string | undefined>(undefined);
  const [dispatchLive, setDispatchLive] = useState<Record<string, boolean>>({});

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await gateway.listSessions();
    if (!alive.current) return;
    if (result.ok) {
      setSessions(deckSessions(result.value, roomId));
      setSkewReason(null);
    } else {
      setSkewReason(result.error.message);
    }
  }, [gateway, roomId]);

  // One refresh per event burst; pty storms (an agent's observers hopping around)
  // must not turn into a listing per event.
  const kick = useMemo(() => coalesce(refresh), [refresh]);

  useEffect(() => {
    kick();
    void gateway.whoami().then((r) => {
      if (alive.current && r.ok) setMe(r.value.fde);
    });
    void gateway.specEvents(roomId).then((r) => {
      if (alive.current && r.ok) setEvents(r.value.events);
    });
  }, [gateway, roomId, kick]);

  useEffect(
    () =>
      gateway.onEvent((event) => {
        if (!isDeckEvent(event, roomId)) return;
        setEvents((current) => [...current, event]);
        kick();
      }),
    [gateway, roomId, kick],
  );

  useEffect(
    () =>
      gateway.onConnectionStatus((status) => {
        if (status.phase === "ready") kick();
      }),
    [gateway, kick],
  );

  const reasons = useMemo(() => endedReasons(events), [events]);
  const skew = skewOf(skewReason ?? undefined);

  // Chips are the host's truth plus the sessions we just opened and the listing
  // hasn't confirmed yet — the optimistic entry disappears once the host lists it.
  const chips = useMemo(() => {
    const listed = new Set(sessions.map((s) => s.name));
    const pending = [...opened.entries()]
      .filter(([name]) => !listed.has(name))
      .map(([name, spec]) => ({
        name,
        live: true,
        attached: 1,
        writerFde: me ?? "",
        room: roomId,
        command: spec.command,
      }));
    return [...sessions, ...pending];
  }, [sessions, opened, me, roomId]);

  /** A yielded corpse reopens only when no dispatch is live on the spec it yielded to. */
  const probeDispatch = useCallback(
    (specId: string) => {
      void gateway.listRuns(specId).then((r) => {
        if (!alive.current) return;
        const running = r.ok && r.value.runs.some((run) => run.status === "running");
        setDispatchLive((current) =>
          current[specId] === running ? current : { ...current, [specId]: running },
        );
      });
    },
    [gateway],
  );

  const select = (name: string) => {
    if (selected === name) {
      setSelected(null);
      return;
    }
    const session = chips.find((s) => s.name === name);
    if (session?.live && services && !opened.has(name)) {
      setOpened((current) => new Map(current).set(name, { command: session.command }));
    }
    if (session && !session.live) {
      const displaced = yieldedDispatch(reasons[name]);
      if (displaced?.specId) probeDispatch(displaced.specId);
    }
    setSelected(name);
  };

  const open = (glyph: DeckGlyph) => {
    const taken = [...chips.map((s) => s.name), ...opened.keys()];
    const name = nextRoomSession(roomId, taken);
    setOpened((current) => new Map(current).set(name, { command: commandFor(glyph) }));
    setSelected(name);
  };

  const restart = (session: DeckSession) => {
    setOpened((current) =>
      new Map(current).set(session.name, { command: session.command, killFirst: true }),
    );
    setSessions((current) =>
      current.map((s) => (s.name === session.name ? { ...s, live: true } : s)),
    );
    setSelected(session.name);
  };

  const kill = (session: DeckSession) => {
    setClosing(null);
    setOpened((current) => {
      if (!current.has(session.name)) return current;
      const next = new Map(current);
      next.delete(session.name);
      return next;
    });
    if (selected === session.name) setSelected(null);
    void gateway.killSession(session.name).finally(() => kick());
  };

  const selectedChip = selected ? (chips.find((s) => s.name === selected) ?? null) : null;
  const showStage = selectedChip !== null;
  const displaced = selectedChip && !selectedChip.live ? yieldedDispatch(reasons[selectedChip.name]) : null;

  return (
    <>
      <DeckStrip
        sessions={chips}
        roomId={roomId}
        titles={titles}
        selected={selected}
        skew={skew}
        onSelect={select}
        onClose={(session) => setClosing(session)}
        onOpen={open}
      />
      <div className="room-deck-panel__body" style={{ display: showStage ? "none" : "contents" }}>
        {children}
      </div>
      {services &&
        [...opened.entries()].map(([name, spec]) => (
          <div
            key={`${name}:${spec.killFirst ? "revived" : "attached"}`}
            className="room-deck-panel__stage"
            style={{ display: selected === name ? "flex" : "none" }}
          >
            <services.Terminal
              session={name}
              project={project}
              room={roomId}
              command={spec.command}
              killFirst={spec.killFirst}
              active={active && selected === name}
              visible={selected === name}
              me={me}
              writerFde={sessions.find((s) => s.name === name)?.writerFde}
              onTitle={(raw) => {
                const title = shortTitle(raw);
                setTitles((current) =>
                  current[name] === title ? current : { ...current, [name]: title },
                );
              }}
              onStatus={(status) => {
                if (status.kind === "ended") kick();
              }}
            />
          </div>
        ))}
      {selectedChip && !selectedChip.live && !opened.has(selectedChip.name) && (
        <div className="room-deck-panel__stage">
          <DeckEndedCard
            session={selectedChip.name}
            reason={reasons[selectedChip.name]}
            yielded={displaced !== null}
            dispatchLive={displaced?.specId ? (dispatchLive[displaced.specId] ?? true) : false}
            onRestart={services ? () => restart(selectedChip) : undefined}
          />
        </div>
      )}
      {selectedChip?.live && !services && (
        <div className="room-deck-panel__stage">
          <DeckAttachUnavailable session={selectedChip.name} />
        </div>
      )}
      {closing && (
        <Dialog
          isOpen
          onClose={() => setClosing(null)}
          title={`Close session ${closing.name}?`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(null)}>
                Cancel
              </Button>
              <Button className="btn-danger" onClick={() => kill(closing)}>
                Close
              </Button>
            </>
          }
        >
          <p>
            The session and anything running in it will end for everyone in the room.
            Detaching instead leaves it running.
          </p>
        </Dialog>
      )}
    </>
  );
}
