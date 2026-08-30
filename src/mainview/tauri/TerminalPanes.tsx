import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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
  removePane,
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
import { PromptDialog } from "./PromptDialog";
import { type SessionCreate, SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

/**
 * TerminalPanes — one workspace tab's terminals: sub-tabs of durable host sessions, each sub-tab
 * splittable into side-by-side panes. All model logic lives in the tested `terminal/paneLayout`;
 * this edge discovers live sessions from the pty-host, persists the arrangement locally, renders
 * the slim pane bar, and fans a {@link TerminalHandle} + aggregated status up to the workspace.
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

export interface TerminalPanesProps {
  /** ssh alias of a project container; omitted = shells on the node itself. */
  readonly target?: string;
  /** True when this workspace tab is the visible one. */
  readonly active: boolean;
  /** Aggregated lifecycle of every pane (the worst one wins) for the tab bar. */
  readonly onStatus?: (status: SessionStatus) => void;
}

function storageKey(base: string): string {
  return `mast.panes.${base}`;
}

export const TerminalPanes = forwardRef<TerminalHandle, TerminalPanesProps>(
  function TerminalPanes({ target, active, onStatus }, ref) {
    const base = baseSessionFor(target);
    const create: SessionCreate = { ...BASE_CREATE, project: projectFor(target) };
    const [layout, setLayout] = useState<PaneLayout | null>(null);
    const [focused, setFocused] = useState<string>(base);
    const [visited, setVisited] = useState<ReadonlySet<number>>(new Set());
    const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
    const [closing, setClosing] = useState<string[] | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [chipMenu, setChipMenu] = useState<{ x: number; y: number; group: number } | null>(null);
    const [titles, setTitles] = useState<Record<string, string>>({});
    const paneRefs = useRef(new Map<string, TerminalHandle>());

    /** Menu actions, injected into the tested builders in terminal/paneMenu. */
    const menuActions: PaneMenuActions = {
      rename: setRenaming,
      setColor: (session, color) => setLayout((l) => l && withPaneMeta(l, session, { color })),
      close: (sessions) => setClosing(sessions),
    };

    // Existence is the host's truth: reconcile the stored arrangement against its live sessions.
    useEffect(() => {
      let cancelled = false;
      const settle = (live: string[]) => {
        if (cancelled) return;
        let next: PaneLayout;
        try {
          next = reconcile(parseLayout(localStorage.getItem(storageKey(base))), live, base);
        } catch {
          // A poisoned stored value must never blank the tab forever — heal to the default.
          try {
            localStorage.removeItem(storageKey(base));
          } catch {
            /* storage is a convenience */
          }
          next = defaultLayout(base);
        }
        setLayout(next);
        setVisited(new Set([next.groups[next.active]!.id]));
        // Focus must land in the ACTIVE group — a restored focus in some other group would leave
        // the visible split entirely unfocused (every pane dimmed, keyboard going nowhere).
        setFocused((f) => {
          const panes = next.groups[next.active]!.panes;
          return panes.includes(f) ? f : panes[0]!;
        });
      };
      void invoke<Array<{ name: string; live: boolean }>>("session_list", {
        socketPath: NODE_SOCKET,
        token: "",
      })
        .then((list) => settle(list.filter((s) => s.live).map((s) => s.name)))
        .catch(() => settle([]));
      return () => {
        cancelled = true;
      };
    }, [base]);

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

    const addShell = () => {
      if (!layout || layout.groups.length >= MAX_GROUPS) return;
      const name = nextSessionName(sessionsOf(layout), base);
      apply(newGroup(layout, name), name);
    };

    const split = () => {
      if (!layout || layout.groups[layout.active]!.panes.length >= MAX_SPLITS) return;
      const name = nextSessionName(sessionsOf(layout), base);
      apply(splitGroup(layout, layout.active, name), name);
    };

    const confirmClose = (sessions: string[]) => setClosing(sessions);

    const doClose = (sessions: string[]) => {
      setClosing(null);
      if (!layout) return;
      const next = sessions.reduce((acc, s) => removePane(acc, s, base), layout);
      // Closing the LAST shell heals the layout back to the same base session name — the pane
      // stays mounted, so after the kill it must revive into a fresh shell instead of parking
      // on the corpse's "ended" card.
      const resurrected = new Set(sessions.filter((s) => sessionsOf(next).includes(s)));
      for (const session of sessions) {
        const revive = resurrected.has(session)
          ? () => paneRefs.current.get(session)?.revive?.()
          : noop;
        void invoke("session_kill", { socketPath: NODE_SOCKET, token: "", session })
          .catch(noop)
          .finally(revive);
        if (!resurrected.has(session)) {
          paneRefs.current.delete(session);
        }
      }
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
            label="New shell — ⌘T"
            onClick={addShell}
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
                    <SessionTerminalPane
                      ref={(h) => {
                        if (h) paneRefs.current.set(session, h);
                        else paneRefs.current.delete(session);
                      }}
                      socketPath={NODE_SOCKET}
                      token=""
                      session={session}
                      create={create}
                      active={active && groupActive && session === focused}
                      visible={active && groupActive}
                      onStatus={(s) => {
                        if (statusesRef.current[session] !== s) onPaneStatus(session, s);
                      }}
                      onTitle={(raw) => {
                        const t = shortTitle(raw);
                        setTitles((prev) => (prev[session] === t ? prev : { ...prev, [session]: t }));
                      }}
                      menuExtras={paneMenuItems(layout, session, base, menuActions, titles)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
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
