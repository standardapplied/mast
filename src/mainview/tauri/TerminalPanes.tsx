import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { cx } from "../components/cx";
import { Button } from "../components/ui";
import { isUnwell, type SessionStatus, statusEqual, worstStatus } from "../terminal/connection";
import { Tooltip } from "../components/Tooltip";
import {
  baseSessionFor,
  defaultLayout,
  labelFor,
  newGroup,
  nextSessionName,
  type PaneLayout,
  paneCount,
  parseLayout,
  projectFor,
  reconcile,
  removePane,
  sessionsOf,
  splitGroup,
  titleOf,
  withPaneMeta,
} from "../terminal/paneLayout";
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

/** The swatches a shell can wear (ghostty-style tab dots) — index is what the layout stores. */
const PANE_COLORS = [
  "#fc4926",
  "#e0a24d",
  "#e8d44d",
  "#86b89a",
  "#4de0c8",
  "#5b9bd5",
  "#a78bfa",
  "#d08fa6",
] as const;

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
    const paneRefs = useRef(new Map<string, TerminalHandle>());

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
        setFocused((f) => (sessionsOf(next).includes(f) ? f : next.groups[next.active]!.panes[0]!));
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

    // Report structurally — worstStatus mints fresh objects and onStatus is an inline closure, so
    // an identity-based report would ping-pong renders with the workspace forever.
    const lastReported = useRef<SessionStatus | null>(null);
    useEffect(() => {
      if (!layout) return;
      const worst = worstStatus(
        sessionsOf(layout).map((s) => statuses[s]).filter((s) => s !== undefined),
      );
      if (lastReported.current && statusEqual(lastReported.current, worst)) return;
      lastReported.current = worst;
      onStatus?.(worst);
    }, [layout, statuses, onStatus]);

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
      for (const session of sessions) {
        void invoke("session_kill", { socketPath: NODE_SOCKET, token: "", session }).catch(noop);
        paneRefs.current.delete(session);
      }
      setStatuses((prev) => {
        const next = { ...prev };
        for (const session of sessions) delete next[session];
        return next;
      });
      const next = sessions.reduce((acc, s) => removePane(acc, s, base), layout);
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

    const closable = paneCount(layout) > 1;

    return (
      <div className="term-panes" onKeyDown={onKeyDown}>
        <div className="term-panes__bar">
          {layout.groups.map((group, i) => {
            const unwell = group.panes.some((s) => {
              const st = statuses[s];
              return st !== undefined && isUnwell(st);
            });
            const plainLabel = group.panes.map((s) => titleOf(layout, s, base)).join("·");
            return (
              <button
                key={group.id}
                type="button"
                className={cx("term-pane-chip", i === layout.active && "is-active")}
                onClick={() => activateGroup(i)}
                onDoubleClick={() =>
                  setRenaming(group.panes.includes(focused) ? focused : group.panes[0]!)
                }
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
                      {titleOf(layout, s, base)}
                    </span>
                  );
                })}
                {closable && (
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
                )}
              </button>
            );
          })}
          <Tooltip content="New shell — ⌘T" side="bottom">
            <button
              type="button"
              className="term-pane-chip term-pane-chip--tool"
              aria-label="New shell"
              onClick={addShell}
              disabled={layout.groups.length >= MAX_GROUPS}
            >
              ＋
            </button>
          </Tooltip>
          <Tooltip content="Split right — ⌘D" side="bottom">
            <button
              type="button"
              className="term-pane-chip term-pane-chip--tool"
              aria-label="Split right"
              onClick={split}
              disabled={layout.groups[layout.active]!.panes.length >= MAX_SPLITS}
            >
              ◫
            </button>
          </Tooltip>
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
                      onStatus={(s) =>
                        setStatuses((prev) => (prev[session] === s ? prev : { ...prev, [session]: s }))
                      }
                      menuExtras={[
                        {
                          kind: "item",
                          label: "Rename shell…",
                          onSelect: () => setRenaming(session),
                        },
                        {
                          kind: "item",
                          label: "Color",
                          submenu: [
                            {
                              kind: "item",
                              label: "None",
                              onSelect: () =>
                                setLayout((l) => l && withPaneMeta(l, session, { color: undefined })),
                            },
                            ...PANE_COLORS.map((hex, index) => ({
                              kind: "item" as const,
                              label: (
                                <>
                                  <span
                                    className="term-pane-dot"
                                    style={{ background: hex }}
                                    aria-hidden
                                  />
                                  {`Color ${index + 1}`}
                                </>
                              ),
                              onSelect: () =>
                                setLayout((l) => l && withPaneMeta(l, session, { color: index })),
                            })),
                          ],
                        },
                        ...(closable
                          ? [
                              {
                                kind: "item" as const,
                                label: `Close pane ${titleOf(layout, session, base)}`,
                                danger: true,
                                onSelect: () => confirmClose([session]),
                              },
                            ]
                          : []),
                      ]}
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
                ? `Close shell ${labelFor(closing[0]!, base)}?`
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
        {renaming && layout && (
          <PromptDialog
            title={`Rename shell ${labelFor(renaming, base)}`}
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
