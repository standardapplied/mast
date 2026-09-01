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
import { Button } from "../components/ui";
import { isUnwell, type SessionStatus, statusEqual, worstStatus } from "../terminal/connection";
import { IconButton } from "../components/IconButton";
import { Plus, SplitColumns } from "../components/icons";
import {
  baseSessionFor,
  defaultLayout,
  newGroup,
  nextSessionName,
  type PaneLayout,
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
import { type SessionCreate, SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

/**
 * TerminalPanes — one workspace tab's terminals: sub-tabs of durable host sessions, each sub-tab
 * splittable into side-by-side panes. All model logic lives in the tested `terminal/paneLayout`;
 * this edge discovers live sessions from the pty-host, persists the arrangement locally, renders
 * the slim pane bar, and fans a {@link TerminalHandle} + aggregated status up to the workspace.
 *
 * Two scopes share this one implementation. A project tab (`target`) names sessions
 * `mast-<target>.n` and every pane is a plain shell. A room route (`room`) names them
 * `room-<id>.n`, adopts the room's foreign-named sessions (`resume-*`), lets ＋ pick
 * Shell / Claude Code / Codex (⌘T repeats the last pick, ⌘D splits a plain shell), and
 * parks a listed corpse on the shipped ended card — with the dispatch-yield Reopen
 * gating — instead of silently recreating a dead agent session (see `panePlan`).
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
const BASE_CREATE = { command: ["bash", "-l"], cwd: "~", cols: 80, rows: 24 };
const MAX_SPLITS = 4;
const MAX_GROUPS = 8;


const noop = () => {};

/** The room the panes are scoped to; its data layer lives with the route's workbench. */
export interface RoomScope {
  readonly roomId: string;
  readonly project: string;
  /** The room's slice of the session store (live sessions and corpses). */
  readonly sessions: readonly SessionEntry[];
  /** Ended reasons by session, from the room's pty event history. */
  readonly reasons: Readonly<Record<string, string>>;
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
  /** Aggregated lifecycle of every pane (the worst one wins) for the tab bar. */
  readonly onStatus?: (status: SessionStatus) => void;
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

    /** Menu actions, injected into the tested builders in terminal/paneMenu. */
    const menuActions: PaneMenuActions = {
      rename: setRenaming,
      setColor: (session, color) => setLayout((l) => l && withPaneMeta(l, session, { color })),
      close: (sessions) => setClosing(sessions),
    };

    /** Restores the stored arrangement against the host's truth and lands the focus. */
    const settle = useCallback(
      (next: PaneLayout, focusPane?: string) => {
        setLayout(next);
        setVisited(new Set([next.groups[next.active]!.id]));
        // Focus must land in the ACTIVE group — a restored focus in some other group would leave
        // the visible split entirely unfocused (every pane dimmed, keyboard going nowhere).
        setFocused((f) => {
          const panes = next.groups[next.active]!.panes;
          if (focusPane && panes.includes(focusPane)) return focusPane;
          return panes.includes(f) ? f : panes[0]!;
        });
      },
      [],
    );

    const restore = useCallback(
      (live: readonly string[], adopt?: ReadonlySet<string>): PaneLayout => {
        try {
          const dead = new Set(sessionStore.deaths().keys());
          return reconcile(
            parseLayout(localStorage.getItem(storageKey(base))),
            live,
            base,
            adopt,
            dead,
          );
        } catch {
          // A poisoned stored value must never blank the tab forever — heal to the default.
          try {
            localStorage.removeItem(storageKey(base));
          } catch {
            /* storage is a convenience */
          }
          return defaultLayout(base);
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
          const command = commandFor(entry.launch);
          // An empty room's reconciled layout is only the filler base pane; the launch
          // takes that name instead of minting a sibling (which would also auto-create
          // a phantom shell in the filler).
          const filler =
            names.length === 0 && parseLayout(localStorage.getItem(storageKey(base))) === null;
          const name = filler ? base : nextSessionName([...sessionsOf(next), ...names], base);
          setLaunched((m) => new Map(m).set(name, { command }));
          sessionStore.noteLaunch(name, command, entry.roomId);
          if (!filler) next = newGroup(next, name);
          focusPane = name;
        }
        settle(next, focusPane);
        settledBase.current = base;
        return;
      }
      const inventory = sessionStore.sessions();
      if (inventory === null && sessionStore.connected) return;
      settle(restore((inventory ?? []).filter((s) => s.live).map((s) => s.name)));
      settledBase.current = base;
    }, [base, restore, settle, storeVersion]);

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

    useEffect(() => {
      if (!layout) return;
      try {
        localStorage.setItem(storageKey(base), JSON.stringify(layout));
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
    const lastReported = useRef<SessionStatus | null>(null);
    const reportAggregate = useCallback(() => {
      const current = layoutRef.current;
      if (!current) return;
      const worst = worstStatus(
        sessionsOf(current)
          .map((s) => statusesRef.current[s])
          .filter((s) => s !== undefined),
      );
      if (lastReported.current && statusEqual(lastReported.current, worst)) return;
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
        const id = next.groups[next.active]!.id;
        return v.has(id) ? v : new Set([...v, id]);
      });
      if (focus) setFocused(focus);
    }, []);

    /** Every name spoken for: panes in the layout, the room's listing, pending launches. */
    const takenNames = () => [
      ...(layout ? sessionsOf(layout) : []),
      ...(room?.sessions.map((s) => s.name) ?? []),
      ...launched.keys(),
    ];

    const addShell = (glyph: DeckGlyph = room ? lastGlyph : "shell") => {
      if (!layout || layout.groups.length >= MAX_GROUPS) return;
      const name = nextSessionName(takenNames(), base);
      if (room) {
        setLastGlyph(glyph);
        setLaunched((m) => new Map(m).set(name, { command: commandFor(glyph) }));
        sessionStore.noteLaunch(name, commandFor(glyph), room.roomId);
      }
      apply(newGroup(layout, name), name);
    };

    const split = () => {
      if (!layout || layout.groups[layout.active]!.panes.length >= MAX_SPLITS) return;
      const name = nextSessionName(takenNames(), base);
      if (room) {
        setLaunched((m) => new Map(m).set(name, { command: commandFor("shell") }));
        sessionStore.noteLaunch(name, commandFor("shell"), room.roomId);
      }
      apply(splitGroup(layout, layout.active, name), name);
    };

    const confirmClose = (sessions: string[]) => setClosing(sessions);

    const doClose = (sessions: string[]) => {
      setClosing(null);
      if (!layout) return;
      // Closing the LAST shell heals the layout back to the same base session name — the pane
      // stays mounted, so after the kill it must revive into a fresh shell instead of parking
      // on the corpse's "ended" card. A room never auto-revives: closing its last pane parks
      // the killed session itself (see removePanes), so the listing refresh lands it on the
      // ended card instead of a healed base name minting an unasked-for replacement shell.
      const next = removePanes(layout, sessions, base, !!room);
      const resurrected = new Set(sessions.filter((s) => sessionsOf(next).includes(s)));
      for (const session of sessions) {
        const revive = !room && resurrected.has(session)
          ? () => paneRefs.current.get(session)?.revive?.()
          : noop;
        // The store's kill path: optimistic transition, ack, death record, re-list —
        // every surface converges through it. The route resolved its room on entry,
        // so in-room closes skip the inventory's fail-closed guard.
        void sessionStore
          .kill(session, room ? { resolvedRoom: room.roomId } : {})
          .finally(revive);
        if (!resurrected.has(session)) {
          paneRefs.current.delete(session);
        }
      }
      setLaunched((m) => {
        if (!sessions.some((s) => m.has(s))) return m;
        const pruned = new Map(m);
        for (const session of sessions) pruned.delete(session);
        return pruned;
      });
      {
        const pruned = { ...statusesRef.current };
        for (const session of sessions) {
          if (!resurrected.has(session)) delete pruned[session];
        }
        statusesRef.current = pruned;
        setStatuses(pruned);
      }
      setTitles((prev) => {
        const pruned = { ...prev };
        for (const session of sessions) delete pruned[session];
        return pruned;
      });
      const survivors = next.groups[next.active]!.panes;
      apply(next, survivors.includes(focused) ? focused : survivors[0]!);
    };

    const activateGroup = (index: number) => {
      if (!layout) return;
      const panes = layout.groups[index]!.panes;
      apply({ ...layout, active: index }, panes.includes(focused) ? focused : panes[0]!);
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

    /** A room pane's content: the terminal, or the shipped ended card with yield gating. */
    const roomCell = (session: string, groupActive: boolean) => {
      const scope = room!;
      const plan = panePlan(session, scope.sessions, launched, sessionStore.deaths());
      if (plan.kind === "ended") {
        const displaced = yieldedDispatch(scope.reasons[session]);
        return (
          <div className="room-pane-ended">
            <DeckEndedCard
              session={session}
              reason={scope.reasons[session]}
              yielded={displaced !== null}
              dispatchLive={
                displaced?.specId ? (scope.dispatchLive[displaced.specId] ?? true) : false
              }
              onRestart={() => {
                setLaunched((m) =>
                  new Map(m).set(session, { command: plan.restartCommand, killFirst: true }),
                );
                sessionStore.noteLaunch(session, plan.restartCommand, scope.roomId);
              }}
            />
          </div>
        );
      }
      const refusal = scope.sessions.find((s) => s.name === session)?.refusal;
      return (
        <RoomTerminal
          ref={(h) => {
            if (h) paneRefs.current.set(session, h);
            else paneRefs.current.delete(session);
          }}
          session={session}
          project={scope.project}
          room={scope.roomId}
          command={plan.command}
          killFirst={plan.killFirst}
          refusal={refusal}
          active={active && groupActive && session === focused}
          visible={active && groupActive}
          me={scope.me}
          writerFde={plan.writerFde}
          onStatus={(s) => {
            if (statusesRef.current[session] !== s) onPaneStatus(session, s);
            // An attach ack is a mutation ack — the create is real, take the
            // reconcile listing so every surface sees it without any event.
            if (s.kind === "up") scope.refresh();
            // The shell (or agent) is gone: hand the pane to the listing, which parks it
            // on the ended card with the host's reason.
            if (s.kind === "ended") {
              setLaunched((m) => {
                if (!m.has(session)) return m;
                const pruned = new Map(m);
                pruned.delete(session);
                return pruned;
              });
              scope.refresh();
            }
          }}
          onTitle={(raw) => {
            const t = shortTitle(raw);
            setTitles((prev) => (prev[session] === t ? prev : { ...prev, [session]: t }));
          }}
          menuExtras={paneMenuItems(layout, session, base, menuActions, titles)}
        />
      );
    };

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
            disabled={layout.groups[layout.active]!.panes.length >= MAX_SPLITS}
          >
            <SplitColumns size={15} />
          </IconButton>
        </div>
        <div className="term-panes__body">
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
                    {room ? (
                      roomCell(session, groupActive)
                    ) : (
                      <SessionTerminalPane
                        ref={(h) => {
                          if (h) paneRefs.current.set(session, h);
                          else paneRefs.current.delete(session);
                        }}
                        socketPath={NODE_SOCKET}
                        token=""
                        session={session}
                        create={{ ...BASE_CREATE, project: projectFor(target) }}
                        active={active && groupActive && session === focused}
                        visible={active && groupActive}
                        onStatus={(s) => {
                          if (statusesRef.current[session] !== s) onPaneStatus(session, s);
                          if (s.kind === "up") sessionStore.refresh();
                        }}
                        onTitle={(raw) => {
                          const t = shortTitle(raw);
                          setTitles((prev) => (prev[session] === t ? prev : { ...prev, [session]: t }));
                        }}
                        menuExtras={paneMenuItems(layout, session, base, menuActions, titles)}
                      />
                    )}
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
