import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { cx } from "../components/cx";
import { Button } from "../components/ui";
import { type SessionStatus, statusEqual, worstStatus } from "../terminal/connection";
import {
  baseSessionFor,
  defaultLayout,
  labelFor,
  newGroup,
  nextSessionName,
  type PaneLayout,
  paneCount,
  projectFor,
  reconcile,
  removePane,
  sessionsOf,
  splitGroup,
} from "../terminal/paneLayout";
import { type SessionCreate, SessionTerminalPane } from "./SessionTerminalPane";
import type { TerminalHandle } from "./TerminalPane";

/**
 * TerminalPanes — one workspace tab's terminals: sub-tabs of durable host sessions, each sub-tab
 * splittable into side-by-side panes. All model logic lives in the tested `terminal/paneLayout`;
 * this edge discovers live sessions from the pty-host, persists the arrangement locally, renders
 * the slim pane bar, and fans a {@link TerminalHandle} + aggregated status up to the workspace.
 *
 * Every pane stays mounted (hidden when its sub-tab is inactive), so switching never detaches a
 * session. Closing a pane *kills* its host session — that is the one destructive act here, so it
 * confirms first; quitting the app merely detaches and every shell survives.
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

function loadStored(base: string): PaneLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(base));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaneLayout;
    return Array.isArray(parsed.groups) ? parsed : null;
  } catch {
    return null;
  }
}

export const TerminalPanes = forwardRef<TerminalHandle, TerminalPanesProps>(
  function TerminalPanes({ target, active, onStatus }, ref) {
    const base = baseSessionFor(target);
    const create: SessionCreate = { ...BASE_CREATE, project: projectFor(target) };
    const [layout, setLayout] = useState<PaneLayout | null>(null);
    const [focused, setFocused] = useState<string>(base);
    const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
    const [closing, setClosing] = useState<string[] | null>(null);
    const paneRefs = useRef(new Map<string, TerminalHandle>());

    // Existence is the host's truth: reconcile the stored arrangement against its live sessions.
    useEffect(() => {
      let cancelled = false;
      const settle = (live: string[]) => {
        if (cancelled) return;
        const next = reconcile(loadStored(base), live, base);
        setLayout(next);
        setFocused((f) => (sessionsOf(next).includes(f) ? f : next.groups[next.active]![0]!));
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
      if (focus) setFocused(focus);
    }, []);

    const addShell = () => {
      if (!layout || layout.groups.length >= MAX_GROUPS) return;
      const name = nextSessionName(sessionsOf(layout), base);
      apply(newGroup(layout, name), name);
    };

    const split = () => {
      if (!layout || layout.groups[layout.active]!.length >= MAX_SPLITS) return;
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
      const survivors = next.groups[next.active]!;
      apply(next, survivors.includes(focused) ? focused : survivors[0]!);
    };

    const activateGroup = (index: number) => {
      if (!layout) return;
      const panes = layout.groups[index]!;
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
            const unwell = group.some((s) => {
              const st = statuses[s];
              return st && st.kind !== "up" && !(st.kind === "connecting" && !st.retrying);
            });
            return (
              <button
                key={group[0]}
                type="button"
                className={cx("term-pane-chip", i === layout.active && "is-active")}
                onClick={() => activateGroup(i)}
              >
                {unwell && <span className="term-status__dot term-status__dot--warn" aria-hidden />}
                {group.map((s) => labelFor(s, base)).join("·")}
                {closable && (
                  <span
                    role="button"
                    aria-label={`Close shell ${group.map((s) => labelFor(s, base)).join("·")}`}
                    className="term-pane-chip__close"
                    onClick={(e) => {
                      e.stopPropagation();
                      confirmClose([...group]);
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="term-pane-chip term-pane-chip--tool"
            title="New shell (⌘T)"
            aria-label="New shell"
            onClick={addShell}
            disabled={layout.groups.length >= MAX_GROUPS}
          >
            ＋
          </button>
          <button
            type="button"
            className="term-pane-chip term-pane-chip--tool"
            title="Split right (⌘D)"
            aria-label="Split right"
            onClick={split}
            disabled={layout.groups[layout.active]!.length >= MAX_SPLITS}
          >
            ◫
          </button>
        </div>
        <div className="term-panes__body">
          {layout.groups.map((group, i) => {
            const groupActive = i === layout.active;
            return (
              <div
                key={group[0]}
                className="term-panes__group"
                style={{ display: groupActive ? "flex" : "none" }}
              >
                {group.map((session) => (
                  <div
                    key={session}
                    className={cx(
                      "term-panes__cell",
                      group.length > 1 && session === focused && "is-focused",
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
                      onStatus={(s) =>
                        setStatuses((prev) => (prev[session] === s ? prev : { ...prev, [session]: s }))
                      }
                      menuExtras={
                        closable
                          ? [
                              {
                                kind: "item",
                                label: `Close pane ${labelFor(session, base)}`,
                                danger: true,
                                onSelect: () => confirmClose([session]),
                              },
                            ]
                          : undefined
                      }
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
            title={closing.length === 1 ? `Close shell ${labelFor(closing[0]!, base)}?` : `Close ${closing.length} shells?`}
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
      </div>
    );
  },
);
