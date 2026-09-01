import { type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RoomsInventory } from "../board/RoomDeck";
import { coalesce } from "../board/roomRouting";
import { SnapshotsPanel } from "../board/SnapshotsPanel";
import { cx } from "../components/cx";
import type { Gateway } from "../gateway";
import { isUnwell, type SessionStatus, statusEqual } from "../terminal/connection";
import {
  foldInventory,
  isPtyEvent,
  type RoomInventory,
  roomGroups,
  type RoomTerminalRequest,
} from "../terminal/roomDeck";
import { IconButton } from "../components/IconButton";
import { Camera } from "../components/icons";
import { ProjectPicker } from "./ProjectPicker";
import type { RosterSources } from "./projectRoster";
import type { TerminalHandle } from "./SessionTerminalPane";
import { addTab, nextActive, tabKey, type Tab } from "./terminalTabs";
import { TerminalPanes } from "./TerminalPanes";
import { TerminalSplit } from "./TerminalSplit";

/** One callback ref fanning out to several consumers (the split's drop-paste + our status cluster). */
function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (value: T | null) => void {
  return (value) => {
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === "function") r(value);
      else (r as { current: T | null }).current = value;
    }
  };
}

/** The tab bar's connection readout for the visible pane: a dot, a word, and the recovery button. */
function StatusCluster({ status, onRevive }: { status: SessionStatus; onRevive: () => void }) {
  const view = statusView(status);
  if (!view) return null;
  return (
    <span className="term-status" title={view.hint}>
      <span className={cx("term-status__dot", `term-status__dot--${view.tone}`)} aria-hidden />
      <span className="term-status__label">{view.label}</span>
      {view.action && (
        <button type="button" className="dep-chip term-status__action" onClick={onRevive}>
          {view.action}
        </button>
      )}
    </span>
  );
}

function statusView(
  status: SessionStatus,
): { label: string; hint: string; tone: "up" | "warn" | "off"; action?: string } | null {
  switch (status.kind) {
    case "up":
      return { label: "Connected", hint: "Session live", tone: "up" };
    case "connecting":
      return status.retrying
        ? { label: "Reconnecting…", hint: "Reattaching to the session", tone: "warn" }
        : { label: "Connecting…", hint: "Attaching to the session", tone: "warn" };
    case "down":
      return { label: "Disconnected", hint: status.reason, tone: "warn", action: "Reconnect" };
    case "ended":
      return { label: "Ended", hint: status.reason, tone: "off", action: "Restart" };
    case "failed":
      return { label: "Failed", hint: status.reason, tone: "warn", action: "Retry" };
  }
}

/**
 * The Terminal section: browser-tab UX over project workspaces. Each open
 * project keeps its own terminal + file tree mounted (hidden when inactive), so
 * switching is instant and never tears down / garbles a live session. "+" opens
 * the picker for another project.
 */
export function TerminalWorkspace({
  sources,
  gateway,
  onOpenRoom,
}: {
  sources: RosterSources;
  gateway?: Gateway;
  /** Jump to a room's terminal route — a Rooms-inventory row's home surface. */
  onOpenRoom?: (request: RoomTerminalRequest) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [snapshotsFor, setSnapshotsFor] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const paneRefs = useRef(new Map<string, TerminalHandle>());

  // The whole-box inventory keeps room sessions visible here — grouped, collapsed,
  // and jumping to their home surface — refreshed on any pty lifecycle event.
  const [roomInventory, setRoomInventory] = useState<RoomInventory>({ sessions: [], rooms: [] });
  const reloadRooms = useMemo(
    () =>
      coalesce(async () => {
        if (!gateway) return;
        const [sessions, rooms] = await Promise.all([gateway.listSessions(), gateway.listRooms()]);
        setRoomInventory((current) =>
          foldInventory(
            current,
            sessions.ok ? sessions.value : null,
            rooms.ok
              ? rooms.value.rooms.map((r) => ({ id: r.id, title: r.title, project: r.project }))
              : null,
          ),
        );
      }),
    [gateway],
  );
  useEffect(() => {
    if (!gateway || !onOpenRoom) return;
    reloadRooms();
    return gateway.onEvent((event) => {
      if (isPtyEvent(event)) reloadRooms();
    });
  }, [gateway, onOpenRoom, reloadRooms]);

  const inventory = onOpenRoom && gateway && (
    <RoomsInventory
      groups={roomGroups(roomInventory.sessions, roomInventory.rooms)}
      onJump={(group, session) =>
        // The route creates sessions in the room's project container, so the jump
        // resolves the room fresh instead of trusting the inventory's snapshot —
        // an unknown or deleted room must never fail open onto the node itself.
        void gateway.getRoom(group.roomId).then((room) => {
          if (!room.ok) return;
          onOpenRoom({
            roomId: room.value.id,
            project: room.value.project,
            title: room.value.title,
            focus: session.name,
          });
        })
      }
      onKill={(session) => void gateway.killSession(session.name).finally(() => reloadRooms())}
    />
  );

  // The project tabs live in the app's top chrome band, not in this view: the strip renders
  // through the #topbar-slot portal (App shows/hides the slot with the active view). The slot is
  // committed before this view can mount (the terminal opens by navigation), so the initializer
  // resolves it in zero extra renders; the effect is only the paranoid fallback.
  const [chromeSlot, setChromeSlot] = useState<Element | null>(() =>
    document.getElementById("topbar-slot"),
  );
  useEffect(() => {
    setChromeSlot((slot) => slot ?? document.getElementById("topbar-slot"));
  }, []);

  const intoChrome = (strip: ReactNode) => (chromeSlot ? createPortal(strip, chromeSlot) : null);

  /** A tab's durable WebGPU terminals (sub-tabs + splits), reporting into the status cluster. */
  const durablePane = (key: string, target: string | undefined, active: boolean, ref?: Ref<TerminalHandle>) => (
    <TerminalPanes
      ref={mergeRefs(ref, (h: TerminalHandle | null) => {
        if (h) paneRefs.current.set(key, h);
        else paneRefs.current.delete(key);
      })}
      target={target}
      active={active}
      onStatus={(s) =>
        setStatuses((prev) => {
          const known = prev[key];
          return known !== undefined && statusEqual(known, s) ? prev : { ...prev, [key]: s };
        })
      }
    />
  );

  const open = (target: string | undefined, label: string) => {
    setTabs((prev) => addTab(prev, target, label));
    setActiveKey(tabKey(target));
    setAdding(false);
  };
  const close = (key: string) => {
    setActiveKey((a) => nextActive(tabs, key, a));
    setTabs((prev) => prev.filter((t) => t.key !== key));
    setStatuses(({ [key]: _closed, ...rest }) => rest);
  };

  const showPicker = tabs.length === 0 || adding;
  const activeTarget = tabs.find((t) => t.key === activeKey)?.target;
  const activeStatus = activeKey && !adding ? statuses[activeKey] : undefined;

  return (
    <div className="term-workspace">
      {intoChrome(
        tabs.length === 0 ? (
          <>
            <div className="topbar__context">Terminal</div>
            {inventory}
          </>
        ) : (
        <div className="term-tabs">
          <div className="term-tabs__scroll" role="tablist">
          {tabs.map((t) => {
            const s = statuses[t.key];
            const unwell = s !== undefined && isUnwell(s);
            return (
              <div
                key={t.key}
                role="tab"
                aria-selected={t.key === activeKey && !adding}
                className={cx("term-tab", t.key === activeKey && !adding && "is-active")}
                onClick={() => {
                  setActiveKey(t.key);
                  setAdding(false);
                }}
              >
                {unwell && <span className="term-status__dot term-status__dot--warn" aria-hidden />}
                <span className="term-tab__label">{t.label}</span>
                <button
                  type="button"
                  className="term-tab__close"
                  aria-label={`Close ${t.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.key);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className={cx("term-tab__add", adding && "is-active")}
            aria-label="Open another project"
            onClick={() => setAdding(true)}
          >
            ＋
          </button>
          </div>
          <span className="term-tab__tools">
            {inventory}
            {activeStatus && (
              <StatusCluster
                status={activeStatus}
                onRevive={() => paneRefs.current.get(activeKey!)?.revive?.()}
              />
            )}
            {gateway && activeTarget && !adding && (
              <IconButton label="Snapshots" onClick={() => setSnapshotsFor(activeTarget)}>
                <Camera size={15} />
              </IconButton>
            )}
          </span>
        </div>
        ),
      )}

      <div className="term-workspace__body">
        {tabs.map((t) => {
          const active = t.key === activeKey && !showPicker;
          return (
            <div
              key={t.key}
              className="term-workspace__view"
              style={{ display: active ? "flex" : "none" }}
            >
              {t.target ? (
                <TerminalSplit
                  target={t.target}
                  active={active}
                  terminal={(ref) => durablePane(t.key, t.target, active, ref)}
                />
              ) : (
                durablePane(t.key, undefined, active)
              )}
            </div>
          );
        })}
        {showPicker && (
          <ProjectPicker
            sources={sources}
            onPick={open}
            onCancel={tabs.length > 0 ? () => setAdding(false) : undefined}
          />
        )}
      </div>
      {gateway && snapshotsFor && (
        <SnapshotsPanel
          gateway={gateway}
          project={snapshotsFor}
          onClose={() => setSnapshotsFor(null)}
        />
      )}
    </div>
  );
}
