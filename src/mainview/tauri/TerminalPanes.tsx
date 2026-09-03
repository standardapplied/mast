import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DeckEndedCard } from "../board/RoomDeck";
import { ContextMenu } from "../components/ContextMenu";
import { Dialog } from "../components/Dialog";
import { cx } from "../components/cx";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui";
import {
  absenceReason,
  isUnwell,
  type SessionStatus,
  statusEqual,
  worstStatus,
} from "../terminal/connection";
import { IconButton } from "../components/IconButton";
import { Plus, SplitColumns } from "../components/icons";
import {
  baseSessionFor,
  dropExited,
  emptyLayout,
  newGroup,
  nextSessionName,
  type PaneLayout,
  paneCount,
  parseLayout,
  projectFor,
  reconcile,
  removePanes,
  sessionsOf,
  shortTitle,
  splitGroup,
  titleOf,
  withPaneMeta,
} from "../terminal/paneLayout";
import {
  chipMenuItems,
  PANE_COLORS,
  type PaneMenuActions,
  paneMenuItems,
} from "../terminal/paneMenu";
import {
  commandFor,
  DECK_LAUNCHERS,
  type DeckGlyph,
  endedCardModel,
  GLYPH_MARKS,
  type LaunchSpec,
  panePlan,
  roomSessionBase,
  type SessionEntry,
  yieldedDispatch,
} from "../terminal/roomDeck";
import { sessionStore } from "../terminal/sessionStore";
import { PromptDialog } from "./PromptDialog";
import { RoomTerminal } from "./RoomTerminal";
import { SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

/**
 * TerminalPanes — one workspace tab's terminals: sub-tabs of durable host sessions, each sub-tab
 * splittable into side-by-side panes. All model logic lives in the tested `terminal/paneLayout`
 * and `terminal/roomDeck`; this edge reads existence from the session store, persists the
 * arrangement locally, renders the slim pane bar, and fans a {@link TerminalHandle} + aggregated
 * status up to the workspace.
 *
 * Two scopes share this one implementation. A project tab (`target`) names sessions
 * `mast-<target>.n` and every pane is a plain shell. A room route (`room`) names them
 * `room-<id>.n`, adopts the room's foreign-named sessions (`resume-*`), and lets ＋ pick
 * Shell / Claude Code / Codex (⌘T repeats the last pick, ⌘D splits a plain shell).
 *
 * Lifecycle law: nothing is created without a user action, and every absence is explained.
 * A pane attaches only to a session this client launched (create) or the host lists live
 * (attach); anything else — a listed corpse, a session the store watched die, a stored pane
 * the host no longer lists — parks on the ended card saying what the client can prove, with
 * Restart as the user's verb (see `panePlan`). A shell that exits leaves the layout like a
 * closed chip; the last pane of a project tab leaves an empty tab, the last pane of a room
 * route parks on the card. Closing the last pane never revives anything.
 *
 * Mounting is lazy: a sub-tab's panes first mount when it is first shown, so a restored multi-tab
 * layout doesn't attach (or geometry-thrash) sessions nobody is looking at. Once visited, panes
 * stay mounted — hidden ones keep their attach but stop drawing (the pane gates its own frames).
 *
 * Closing a pane *kills* its host session — that is the one destructive act here, so it confirms
 * first; quitting the app merely detaches and every shell survives.
 */

/** The pty-host unix socket on the devbox; `~` expands against the remote home on the Rust side. */
const NODE_SOCKET = "~/.sail/pty.sock";
const BASE_CREATE = { cwd: "~", cols: 80, rows: 24 };
const MAX_SPLITS = 4;
const MAX_GROUPS = 8;
const CLEAN_EXIT = "exited(0)";

/** The room the panes are scoped to; its data layer lives with the route's workbench. */
export interface RoomScope {
  readonly roomId: string;
  readonly project: string;
  /** The room's slice of the session store (live sessions and corpses). */
  readonly sessions: readonly SessionEntry[];
  /** specId → a dispatch is live there (Reopen withheld until confirmed absent). */
  readonly dispatchLive: Readonly<Record<string, boolean>>;
  /** The caller's FDE, for the pane's observer banner. */
  readonly me?: string;
  /** Focus this session on mount (a deck card was clicked). */
  readonly focus?: string;
  /** Open a fresh session of this glyph on mount (Actions ▸ Open terminal ▸ …). */
  readonly launch?: DeckGlyph;
  /** Re-list the room's sessions (a pane ended, a close landed). */
  readonly refresh: () => void;
}

export interface TerminalPanesProps {
  /** ssh alias of a project container; omitted = shells on the node itself. */
  readonly target?: string;
  /** Room scope — the route's workbench; wins over `target`. */
  readonly room?: RoomScope;
  /** True when this workspace tab is the visible one. */
  readonly active: boolean;
  /** Aggregated lifecycle of every pane (the worst one wins) for the tab bar; null = no panes. */
  readonly onStatus?: (status: SessionStatus | null) => void;
}

function storageKey(base: string): string {
  return `mast.panes.${base}`;
}

export const TerminalPanes = forwardRef<TerminalHandle, TerminalPanesProps>(
  function TerminalPanes({ target, room, active, onStatus }, ref) {
    const base = room ? roomSessionBase(room.roomId) : baseSessionFor(target);
    const [layout, setLayout] = useState<PaneLayout | null>(null);
    const [focused, setFocused] = useState<string>(base);
    const [visited, setVisited] = useState<ReadonlySet<number>>(new Set());
    const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
    const [closing, setClosing] = useState<string[] | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [chipMenu, setChipMenu] = useState<{ x: number; y: number; group: number } | null>(null);
    const [titles, setTitles] = useState<Record<string, string>>({});
    /** Sessions this client opened or revived, with their picked commands. */
    const [launched, setLaunched] = useState<ReadonlyMap<string, LaunchSpec>>(new Map());
    const [lastGlyph, setLastGlyph] = useState<DeckGlyph>(room?.launch ?? "shell");
    const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
    const paneRefs = useRef(new Map<string, TerminalHandle>());
    const roomRef = useRef(room);
    roomRef.current = room;
    /** The host boot the stored arrangement was last reconciled under (see absenceReason). */
    const restoredUnder = useRef<string | undefined>(undefined);
    const { showToast } = useToast();

    /** Menu actions, injected into the tested builders in terminal/paneMenu. */
    const menuActions: PaneMenuActions = {
      rename: setRenaming,
      setColor: (session, color) => setLayout((l) => l && withPaneMeta(l, session, { color })),
      close: (sessions) => setClosing(sessions),
    };

    const launch = useCallback(
      (name: string, command: string[]) => {
        setLaunched((m) => new Map(m).set(name, { command }));
        sessionStore.noteLaunch(name, command, roomRef.current?.roomId ?? "");
      },
      [],
    );

    /** Restores the stored arrangement against the host's truth and lands the focus. */
    const settle = useCallback(
      (next: PaneLayout, focusPane?: string) => {
        setLayout(next);
        const shown = next.groups[next.active];
        setVisited(new Set(shown ? [shown.id] : []));
        // Focus must land in the ACTIVE group — a restored focus in some other group would leave
        // the visible split entirely unfocused (every pane dimmed, keyboard going nowhere).
        setFocused((f) => {
          const panes = shown?.panes ?? [];
          if (focusPane && panes.includes(focusPane)) return focusPane;
          return panes.includes(f) ? f : (panes[0] ?? f);
        });
      },
      [],
    );

    const restore = useCallback(
      (live: readonly string[], adopt?: ReadonlySet<string>): PaneLayout => {
        try {
          const stored = parseLayout(localStorage.getItem(storageKey(base)));
          restoredUnder.current = stored?.hostBootId;
          return reconcile(stored, live, base, adopt, new Set(sessionStore.deaths().keys()));
        } catch {
          // A poisoned stored value must never blank the tab forever — heal to empty.
          try {
            localStorage.removeItem(storageKey(base));
          } catch {
            /* storage is a convenience */
          }
          return emptyLayout();
        }
      },
      [base],
    );

    // Existence is the session store's truth: reconcile the stored arrangement against
    // its inventory (a room route reads its own slice and honors the entry request —
    // focus the picked card's session, or mint the launched one). A project tab waits
    // for the store's first listing; a store that never connected settles empty.
    const storeVersion = useSyncExternalStore(sessionStore.subscribe, () => sessionStore.version);
    const settledBase = useRef<string | null>(null);
    useEffect(() => {
      if (settledBase.current === base) return;
      const entry = roomRef.current;
      if (entry) {
        const names = entry.sessions.map((s) => s.name);
        let next = restore(names, new Set(names));
        if (entry.focus) {
          const index = next.groups.findIndex((g) => g.panes.includes(entry.focus!));
          if (index >= 0) next = { ...next, active: index };
        }
        let focusPane = entry.focus;
        if (entry.launch) {
          const name = nextSessionName([...sessionsOf(next), ...names], base);
          launch(name, commandFor(entry.launch));
          next = newGroup(next, name);
          focusPane = name;
        }
        settle(next, focusPane);
        settledBase.current = base;
        return;
      }
      const inventory = sessionStore.sessions();
      // A failed first listing (skew, unreachable) settles like a listing would —
      // stored panes park on their cards; only a store that is connected and
      // silent is worth waiting on.
      if (inventory === null && sessionStore.connected && sessionStore.skewReason() === null) {
        return;
      }
      let next = restore((inventory ?? []).filter((s) => s.live).map((s) => s.name));
      // Opening a project tab IS the user's action: a tab with nothing in it gets its
      // first shell now; from then on only ＋, ⌘T, ⌘D, and Restart create anything.
      if (paneCount(next) === 0) {
        launch(base, commandFor("shell"));
        next = newGroup(next, base);
      }
      settle(next);
      settledBase.current = base;
    }, [base, launch, restore, settle, storeVersion]);

    // The room keeps living while the route is up: sessions opened elsewhere (another
    // Mac, `sail agent attach`) join the layout as their own sub-tabs on each listing.
    // Only LIVE strays join here — corpses were adopted once on entry, and re-adopting
    // them would resurrect a group the user just closed the moment its kill is listed.
    // The store's death records prune the other direction: a stored pane whose session
    // was watched dying and is no longer listed must not survive the arrangement.
    const roomSessions = room?.sessions;
    useEffect(() => {
      if (!roomSessions) return;
      setLayout((current) => {
        if (!current) return current;
        const live = roomSessions.filter((s) => s.live).map((s) => s.name);
        const dead = new Set(sessionStore.deaths().keys());
        const next = reconcile(
          current,
          live,
          base,
          new Set(roomSessions.map((s) => s.name)),
          dead,
        );
        return JSON.stringify(next.groups) === JSON.stringify(current.groups) ? current : next;
      });
    }, [roomSessions, base]);

    // The stored form carries the host boot it was reconciled under, so a later mount can
    // tell "host restarted" from "not running" for a pane the host no longer lists.
    useEffect(() => {
      if (!layout) return;
      try {
        const hostBootId = sessionStore.hostBootId() ?? restoredUnder.current;
        localStorage.setItem(storageKey(base), JSON.stringify({ ...layout, hostBootId }));
      } catch {
        /* arrangement is a convenience */
      }
    }, [layout, base]);

    // The tab-bar cluster mirrors the worst pane SYNCHRONOUSLY with every pane report — routing
    // it through render effects left windows where a recovery report could lag or be skipped
    // (the header stuck on "Disconnected" after a successful reconnect, seen in the field).
    // Structural comparison, because worstStatus hands back pane-owned objects.
    const statusesRef = useRef<Record<string, SessionStatus>>({});
    const layoutRef = useRef<PaneLayout | null>(null);
    layoutRef.current = layout;
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    const lastReported = useRef<SessionStatus | null | undefined>(undefined);
    const reportAggregate = useCallback(() => {
      const current = layoutRef.current;
      if (!current) return;
      const worst = worstStatus(
        sessionsOf(current)
          .map((s) => statusesRef.current[s])
          .filter((s) => s !== undefined),
      );
      const prev = lastReported.current;
      const unchanged =
        prev !== undefined &&
        (prev === null ? worst === null : worst !== null && statusEqual(prev, worst));
      if (unchanged) return;
      lastReported.current = worst;
      onStatusRef.current?.(worst);
    }, []);
    const onPaneStatus = useCallback(
      (session: string, s: SessionStatus) => {
        statusesRef.current = { ...statusesRef.current, [session]: s };
        setStatuses(statusesRef.current);
        reportAggregate();
      },
      [reportAggregate],
    );
    useEffect(() => {
      reportAggregate();
    }, [layout, reportAggregate]);

    const apply = useCallback((next: PaneLayout, focus?: string) => {
      setLayout(next);
      setVisited((v) => {
        const shown = next.groups[next.active];
        return !shown || v.has(shown.id) ? v : new Set([...v, shown.id]);
      });
      if (focus) setFocused(focus);
    }, []);

    /** Drops what this component remembers about panes that left the layout. */
    const forget = (sessions: readonly string[]) => {
      for (const session of sessions) paneRefs.current.delete(session);
      setLaunched((m) => {
        if (!sessions.some((s) => m.has(s))) return m;
        const pruned = new Map(m);
        for (const session of sessions) pruned.delete(session);
        return pruned;
      });
      const pruned = { ...statusesRef.current };
      for (const session of sessions) delete pruned[session];
      statusesRef.current = pruned;
      setStatuses(pruned);
      setTitles((prev) => {
        const next = { ...prev };
        for (const session of sessions) delete next[session];
        return next;
      });
    };

    /** Lands a layout with the focus on a survivor of its active group. */
    const applyKeepingFocus = (next: PaneLayout) => {
      const survivors = next.groups[next.active]?.panes ?? [];
      apply(next, survivors.includes(focused) ? focused : survivors[0]);
    };

    /** Every name spoken for: panes in the layout, the room's listing, pending launches. */
    const takenNames = () => [
      ...(layout ? sessionsOf(layout) : []),
      ...(room?.sessions.map((s) => s.name) ?? []),
      ...launched.keys(),
    ];

    const addShell = (glyph: DeckGlyph = room ? lastGlyph : "shell") => {
      if (!layout || layout.groups.length >= MAX_GROUPS) return;
      const name = nextSessionName(takenNames(), base);
      if (room) setLastGlyph(glyph);
      launch(name, commandFor(glyph));
      apply(newGroup(layout, name), name);
    };

    const split = () => {
      if (!layout) return;
      const group = layout.groups[layout.active];
      if (!group) return addShell("shell");
      if (group.panes.length >= MAX_SPLITS) return;
      const name = nextSessionName(takenNames(), base);
      launch(name, commandFor("shell"));
      apply(splitGroup(layout, layout.active, name), name);
    };

    const confirmClose = (sessions: string[]) => setClosing(sessions);

    const doClose = (sessions: string[]) => {
      setClosing(null);
      if (!layout) return;
      for (const session of sessions) {
        // A close is a close: the pane leaves, and nothing revives in its place. The
        // store's kill path (optimistic transition, ack, death record, re-list) is the
        // one destructive verb; a pane the host does not list has nothing to kill. The
        // route resolved its room on entry, so in-room closes skip the inventory's
        // fail-closed guard. The pane is gone by the time a refusal lands, so it toasts.
        if (!sessionStore.byName(session)) continue;
        void sessionStore
          .kill(session, room ? { resolvedRoom: room.roomId } : {})
          .then((result) => {
            if (!result.ok) showToast("error", `Close refused — ${result.refusal}`);
          });
      }
      forget(sessions);
      applyKeepingFocus(removePanes(layout, sessions));
    };

    /**
     * The pane's shell exited on its own (or its reconcile listing proved the session gone).
     * The store records the death kill-equivalent — the reason is in hand, no history to
     * wait on — and the pane leaves the layout; a room route's last pane parks on its ended
     * card instead, where Restart mints a fresh session by the user's hand.
     */
    const onExited = (session: string, reason: string) => {
      sessionStore.noteEnded(session, reason);
      const current = layoutRef.current;
      if (current) {
        const next = dropExited(current, session, !!room);
        forget([session]);
        if (next !== current) applyKeepingFocus(next);
      }
      if (reason !== CLEAN_EXIT) {
        const title = current ? titleOf(current, session, base, titles) : session;
        showToast("info", `Shell ${title} ended (${reason})`);
      }
      (room?.refresh ?? sessionStore.refresh)();
    };

    const activateGroup = (index: number) => {
      if (!layout) return;
      const panes = layout.groups[index]?.panes ?? [];
      apply({ ...layout, active: index }, panes.includes(focused) ? focused : panes[0]);
    };

    // Cmd+T (new shell) / Cmd+D (split) bubble up from the focused pane — meta chords are never
    // consumed as pty bytes, so catching them here costs the terminal nothing.
    const onKeyDown = (e: React.KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "t" || e.key === "T") {
        addShell();
        e.preventDefault();
      } else if (e.key === "d" || e.key === "D") {
        split();
        e.preventDefault();
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        paste: (text: string) => paneRefs.current.get(focused)?.paste(text),
        refit: () => {},
        revive: () => {
          for (const [session, status] of Object.entries(statuses)) {
            if (status.kind !== "up") paneRefs.current.get(session)?.revive?.();
          }
        },
      }),
      [focused, statuses],
    );

    if (!layout) {
      return <div className="term-panes" />;
    }

    /** A pane's content: the terminal, or the ended card with the provable reason and Restart. */
    const cell = (session: string, groupActive: boolean) => {
      const deaths = sessionStore.deaths();
      const listed = room ? room.sessions : (sessionStore.sessions() ?? []);
      const plan = panePlan(session, listed, launched, deaths);
      const refusal = listed.find((s) => s.name === session)?.refusal;
      if (plan.kind === "ended") {
        // A death awaiting its durable reason fails closed: the reason gates the
        // dispatch-yield check, so no Restart until the history read lands. An absent
        // session with no record says what the client can prove about the absence.
        const recorded = sessionStore.reasons()[session];
        const reason =
          recorded ??
          (plan.absent ? absenceReason(restoredUnder.current, sessionStore.hostBootId()) : undefined);
        const card = endedCardModel(deaths.get(session), reason);
        const displaced = card.restartable ? yieldedDispatch(card.reason) : null;
        const restart = () => {
          // The store owns the destructive step: a listed corpse must be KILLED
          // through it (a refusal lands inline above, and no launch intent clears
          // the tombstone) before the revive re-mints the name; an absent session
          // has nothing to kill.
          const revive = () => launch(session, plan.restartCommand);
          if (!sessionStore.byName(session)) return revive();
          void sessionStore
            .kill(session, room ? { resolvedRoom: room.roomId } : {})
            .then((result) => {
              if (result.ok) revive();
            });
        };
        return (
          <div className="room-pane-ended">
            {refusal && (
              <div className="room-terminal__refusal" data-testid={`refusal-${session}`}>
                Close refused — {refusal}
              </div>
            )}
            <DeckEndedCard
              session={session}
              reason={card.reason}
              yielded={displaced !== null}
              dispatchLive={
                displaced?.specId ? (room?.dispatchLive[displaced.specId] ?? true) : false
              }
              onRestart={card.restartable ? restart : undefined}
            />
          </div>
        );
      }
      const creating = launched.has(session);
      const paneRef = (h: TerminalHandle | null) => {
        if (h) paneRefs.current.set(session, h);
        else paneRefs.current.delete(session);
      };
      const onPaneReport = (s: SessionStatus) => {
        // The pane re-reports its unchanged status whenever this callback's identity
        // changes; acting on a non-transition would loop — refresh → new listing →
        // rerender → new callback → same report.
        const known = statusesRef.current[session];
        if (known && statusEqual(known, s)) return;
        onPaneStatus(session, s);
        // An attach ack is a mutation ack — the create is real, take the reconcile
        // listing so every surface sees it without any event.
        if (s.kind === "up") (room?.refresh ?? sessionStore.refresh)();
        if (s.kind === "ended") onExited(session, s.reason);
      };
      const onTitle = (raw: string) => {
        const t = shortTitle(raw);
        setTitles((prev) => (prev[session] === t ? prev : { ...prev, [session]: t }));
      };
      const menuExtras = paneMenuItems(layout, session, base, menuActions, titles);
      if (room) {
        return (
          <RoomTerminal
            ref={paneRef}
            session={session}
            project={room.project}
            room={room.roomId}
            command={creating ? plan.command : undefined}
            refusal={refusal}
            active={active && groupActive && session === focused}
            visible={active && groupActive}
            me={room.me}
            writerFde={plan.writerFde}
            onStatus={onPaneReport}
            onTitle={onTitle}
            menuExtras={menuExtras}
          />
        );
      }
      return (
        <SessionTerminalPane
          ref={paneRef}
          socketPath={NODE_SOCKET}
          token=""
          session={session}
          create={
            creating ? { ...BASE_CREATE, command: plan.command, project: projectFor(target) } : undefined
          }
          active={active && groupActive && session === focused}
          visible={active && groupActive}
          onStatus={onPaneReport}
          onTitle={onTitle}
          menuExtras={menuExtras}
        />
      );
    };

    const activeGroup = layout.groups[layout.active];

    return (
      // `terminal-pane` is the drop-target marker classifyDrop keys on (see dropTarget.ts).
      <div className="term-panes terminal-pane" onKeyDown={onKeyDown}>
        <div className="term-panes__bar">
          {layout.groups.map((group, i) => {
            const unwell = group.panes.some((s) => {
              const st = statuses[s];
              return st !== undefined && isUnwell(st);
            });
            const plainLabel = group.panes.map((s) => titleOf(layout, s, base, titles)).join("·");
            return (
              <button
                key={group.id}
                type="button"
                className={cx("term-pane-chip", i === layout.active && "is-active")}
                onClick={() => activateGroup(i)}
                onDoubleClick={() =>
                  setRenaming(group.panes.includes(focused) ? focused : group.panes[0]!)
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setChipMenu({ x: e.clientX, y: e.clientY, group: i });
                }}
              >
                {unwell && <span className="term-status__dot term-status__dot--warn" aria-hidden />}
                {group.panes.map((s, p) => {
                  const color = layout.meta?.[s]?.color;
                  return (
                    <span key={s} className="term-pane-chip__pane">
                      {p > 0 && <span className="term-pane-chip__sep">·</span>}
                      {color !== undefined && PANE_COLORS[color] && (
                        <span
                          className="term-pane-dot"
                          style={{ background: PANE_COLORS[color] }}
                          aria-hidden
                        />
                      )}
                      <span className="term-pane-chip__title">{titleOf(layout, s, base, titles)}</span>
                    </span>
                  );
                })}
                <span
                  role="button"
                  aria-label={`Close shell ${plainLabel}`}
                  className="term-pane-chip__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmClose([...group.panes]);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
          <IconButton
            label={room ? "New terminal — ⌘T repeats the last choice" : "New shell — ⌘T"}
            onClick={(e: React.MouseEvent) => {
              if (!room) return addShell();
              const rect = e.currentTarget.getBoundingClientRect();
              setPicker({ x: rect.left, y: rect.bottom + 4 });
            }}
            disabled={layout.groups.length >= MAX_GROUPS}
          >
            <Plus size={15} />
          </IconButton>
          <IconButton
            label="Split right — ⌘D"
            onClick={split}
            disabled={!activeGroup || activeGroup.panes.length >= MAX_SPLITS}
          >
            <SplitColumns size={15} />
          </IconButton>
        </div>
        <div className="term-panes__body">
          {layout.groups.length === 0 && (
            <div className="term-panes__empty" data-testid="term-panes-empty">
              <div className="room-deck-card">
                <div className="room-deck-card__title">No terminals</div>
                <div className="room-deck-card__reason">
                  Nothing opens on its own — start one with ＋ or ⌘T.
                </div>
                <button type="button" className="term-overlay__btn" onClick={() => addShell()}>
                  {room ? "New terminal" : "New shell"}
                </button>
              </div>
            </div>
          )}
          {layout.groups.map((group, i) => {
            const groupActive = i === layout.active;
            if (!visited.has(group.id)) return null; // first mount happens on first visit
            return (
              <div
                key={group.id}
                className="term-panes__group"
                style={{ display: groupActive ? "flex" : "none" }}
              >
                {group.panes.map((session) => (
                  <div
                    key={session}
                    className={cx(
                      "term-panes__cell",
                      group.panes.length > 1 && session === focused && "is-focused",
                      group.panes.length > 1 && session !== focused && "is-unfocused",
                    )}
                    onPointerDownCapture={() => setFocused(session)}
                  >
                    {cell(session, groupActive)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {picker && room && (
          <ContextMenu
            x={picker.x}
            y={picker.y}
            onClose={() => setPicker(null)}
            items={DECK_LAUNCHERS.map(({ glyph, label }) => ({
              kind: "item" as const,
              label: (
                <span className="deck-menu-launcher" data-testid={`deck-new-${glyph}`}>
                  <span className={`deck-card__glyph deck-card__glyph--${glyph}`} aria-hidden>
                    {GLYPH_MARKS[glyph]}
                  </span>
                  {label}
                </span>
              ),
              onSelect: () => addShell(glyph),
            }))}
          />
        )}
        {closing && (
          <Dialog
            isOpen
            onClose={() => setClosing(null)}
            title={
              closing.length === 1
                ? `Close shell ${titleOf(layout, closing[0]!, base, titles)}?`
                : `Close ${closing.length} shells?`
            }
            size="sm"
            footer={
              <>
                <Button variant="ghost" onClick={() => setClosing(null)}>
                  Cancel
                </Button>
                <Button className="btn-danger" onClick={() => doClose(closing)}>
                  Close
                </Button>
              </>
            }
          >
            <p>
              {closing.length === 1
                ? "The shell and anything running in it will end. Quitting Mast instead leaves every shell running."
                : "These shells and anything running in them will end. Quitting Mast instead leaves every shell running."}
            </p>
          </Dialog>
        )}
        {chipMenu && layout.groups[chipMenu.group] && (
          <ContextMenu
            x={chipMenu.x}
            y={chipMenu.y}
            onClose={() => setChipMenu(null)}
            items={chipMenuItems(
              layout,
              layout.groups[chipMenu.group]!,
              focused,
              base,
              menuActions,
              titles,
            )}
          />
        )}
        {renaming && layout && (
          <PromptDialog
            title={`Rename shell ${titleOf(layout, renaming, base, titles)}`}
            label="Name"
            initial={layout.meta?.[renaming]?.label ?? ""}
            confirmLabel="Rename"
            allowEmpty
            onConfirm={(value) => {
              setLayout((l) => l && withPaneMeta(l, renaming, { label: value }));
              setRenaming(null);
            }}
            onClose={() => setRenaming(null)}
          />
        )}
      </div>
    );
  },
);
