import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ThemeName } from "../../shared/types";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import {
  Reconnector,
  type SessionEnd,
  type SessionStatus,
  toSessionEnd,
} from "../terminal/connection";
import { TerminalRenderer } from "../terminal/renderer";
import { type CellPos, Selection } from "../terminal/selection";
import { paletteFor, resolveThemeName } from "../terminal/terminalPalette";
import { gridFor, type PtySink, TerminalController } from "../terminal/terminalController";
import { VtCore } from "../terminal/vtCore";
import type { TerminalHandle } from "./TerminalPane";

/**
 * SessionTerminalPane — a durable, host-owned pty rendered by our own WebGPU terminal.
 *
 * This is the transport edge: it owns a canvas, wires the pure {@link TerminalController} (VtCore +
 * renderer + a Tauri-backed {@link PtySink}) to the `session_*` commands and `session://` events,
 * and runs the frame loop. All terminal logic lives in the tested `terminal/` modules; this file
 * only bridges them to the live IPC host, so it is the untested, Mac-verified surface — kept thin.
 *
 * Connection lifecycle: the host session outlives any one link, so a dead transport (lid close,
 * network change, keepalive timeout) auto-reattaches on the {@link Reconnector}'s backoff — plus
 * immediately when the window becomes visible or the network returns. A shell that exited is a
 * different matter: the pane parks on an "ended" card until the user restarts it.
 */

const FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", monospace';
const FONT_PX = 15;
const LINE_PAD = 0.25;
const BLINK_MS = 1060;
const BLINK_ON_MS = 600;

/** Tracks Mast's resolved theme, re-rendering when the user flips it or the OS scheme changes. */
function useThemeName(): ThemeName {
  const [name, setName] = useState<ThemeName>(resolveThemeName);
  useEffect(() => {
    const sync = () => setName(resolveThemeName());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", sync);
    };
  }, []);
  return name;
}

/** The pinned VT wasm, fetched once and shared by every pane (see build-tauri-web.ts). */
let wasmPromise: Promise<ArrayBuffer> | null = null;
function vtWasm(): Promise<ArrayBuffer> {
  wasmPromise ??= fetch("/sail-vt.wasm").then((r) => {
    if (!r.ok) throw new Error(`VT wasm failed to load (${r.status})`);
    return r.arrayBuffer();
  });
  return wasmPromise;
}

export interface SessionCreate {
  readonly command: string[];
  readonly cwd: string;
  readonly project: string;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionTerminalProps {
  /** The pty-host unix socket on the devbox (e.g. `~/.sail/pty.sock`). */
  readonly socketPath: string;
  /** The FDE session token; empty attaches as the box owner. */
  readonly token: string;
  /** The host session name to attach to (created first when {@link create} is set). */
  readonly session: string;
  /** Hold the write token (false = read-only observer). */
  readonly write?: boolean;
  /** When set, create this session before attaching; its cols/rows are overridden with the fit. */
  readonly create?: SessionCreate;
  /** True when this pane is the focused one — take keyboard focus so typing lands here. */
  readonly active?: boolean;
  /**
   * True when the pane is on screen (its sub-tab and workspace tab are the visible ones). A hidden
   * pane stays attached but stops drawing, and never pushes its zero-size geometry at the pty.
   */
  readonly visible?: boolean;
  /** Lifecycle reporting for the tab bar's status cluster. */
  readonly onStatus?: (status: SessionStatus) => void;
  /** Extra context-menu entries after Copy/Paste (e.g. the pane host's "Close pane"). */
  readonly menuExtras?: MenuNode[];
}

const noop = () => {};

/** Shared across panes: the sleep-wake liveness probe needs to fire once, not once per pane. */
let lastWakeProbe = 0;
const WAKE_PROBE_GAP_MS = 3000;

/**
 * The system clipboard as text: the Rust side (`pbpaste`) first — WKWebView's own clipboard read
 * is gesture-gated and its paste event never fires on a non-editable surface — then the browser
 * API as the non-Tauri fallback. Empty string when both decline.
 */
async function readClipboard(): Promise<string> {
  try {
    return await invoke<string>("clipboard_read_text");
  } catch {
    try {
      return (await navigator.clipboard?.readText()) ?? "";
    } catch {
      return "";
    }
  }
}

export const SessionTerminalPane = forwardRef<
  TerminalHandle,
  SessionTerminalProps
>(function SessionTerminalPane(
  { socketPath, token, session, write = true, create, active, visible = true, onStatus, menuExtras },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const geomRef = useRef<{ cw: number; ch: number; cols: number; rows: number } | null>(null);
  const dragRef = useRef<CellPos | null>(null);
  const [status, setStatus] = useState<SessionStatus>({ kind: "connecting", retrying: false });
  const statusRef = useRef(status);
  statusRef.current = status;
  const [epoch, setEpoch] = useState(0);
  const reconnector = useRef(new Reconnector());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [backend, setBackend] = useState<string>("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const themeName = useThemeName();
  const palette = paletteFor(themeName);
  const bgCss = `rgb(${palette.bg[0]}, ${palette.bg[1]}, ${palette.bg[2]})`;

  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  /** Tears the current attach down and dials again, painting the "reconnecting" state. */
  const reattach = useCallback(() => {
    clearTimeout(retryTimer.current);
    setStatus({ kind: "connecting", retrying: true });
    setEpoch((e) => e + 1);
  }, []);

  /**
   * The one recovery verb: reattach a dead link now (skipping any scheduled backoff), or — after
   * the shell itself ended — clear the corpse and start a fresh session in its place.
   */
  const revive = useCallback(() => {
    const current = statusRef.current;
    reconnector.current.reset();
    if (current.kind === "ended") {
      void invoke("session_kill", { socketPath, token, session })
        .catch(noop)
        .finally(reattach);
      return;
    }
    reattach();
  }, [socketPath, token, session, reattach]);

  /** Routes text into the pty, parking multi-line pastes on the confirm card first. */
  const tryPaste = useCallback((text: string) => {
    const controller = controllerRef.current;
    if (!controller || text.length === 0) return;
    controller.scroll("bottom");
    if (!controller.paste(text)) {
      setPendingPaste(text);
    }
  }, []);

  const pasteFromClipboard = useCallback(() => {
    void readClipboard().then(tryPaste);
  }, [tryPaste]);

  const copySelection = useCallback((): boolean => {
    const text = controllerRef.current?.selectedText() ?? "";
    if (!text) return false;
    void navigator.clipboard?.writeText(text).catch(noop);
    return true;
  }, []);

  // Drop-to-paste routes through here; the pane refits itself from its own ResizeObserver, so the
  // workbench's post-splitter-drag refit is a no-op. A drop is scripted insertion (single-line
  // shell-quoted paths), not a clipboard paste — never parked on the confirm card.
  useImperativeHandle(
    ref,
    () => ({
      paste: (text: string) => controllerRef.current?.paste(text, { force: true }),
      refit: () => {},
      revive,
    }),
    [revive],
  );

  // A lid reopening or the network returning is the moment a waiting retry should fire — the user
  // is looking at the window right now, so skip the rest of the backoff.
  useEffect(() => {
    const wake = () => {
      const s = statusRef.current;
      if (s.kind === "down" || (s.kind === "connecting" && s.retrying)) {
        reconnector.current.reset();
        reattach();
        return;
      }
      // Still "up"? The link may be dead without knowing it yet (sleep-wake). A throwaway control
      // call probes it: on a dead session the Rust side times out, drops the cached SSH session —
      // which closes this pane's channel — and the resulting exit event drives the reconnect.
      // One probe per wake is plenty: every mounted pane hears the same event, and a stampede of
      // channel-opens would serialize the backend for nothing.
      if (s.kind === "up" && Date.now() - lastWakeProbe > WAKE_PROBE_GAP_MS) {
        lastWakeProbe = Date.now();
        void invoke("session_list", { socketPath, token }).catch(noop);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reattach, socketPath, token]);

  // The retry timer must survive effect re-runs (a theme flip mid-wait) and die with the pane.
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  // Take keyboard focus when this pane's tab becomes the visible one, so keystrokes land in the
  // terminal instead of being dropped on an unfocused div (the old xterm pane focused itself).
  useEffect(() => {
    if (active !== false) hostRef.current?.focus();
  }, [active, epoch]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let disposed = false;
    let raf = 0;
    const cleanups: Array<() => void> = [];
    const id = crypto.randomUUID();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    /** The session is over for this attach; decide between auto-reattach and parking. */
    const onEnd = (end: SessionEnd) => {
      if (disposed) return;
      if (end.klass === "ended") {
        setStatus({ kind: "ended", reason: end.reason });
        return;
      }
      if (end.klass === "refused") {
        // The host said no (foreign session, bad token, dead container) — retrying the same
        // request can only fail the same way, so park with the message and a manual Retry.
        setStatus({ kind: "failed", reason: end.reason });
        return;
      }
      const delay = reconnector.current.lost();
      setStatus({ kind: "down", reason: end.reason });
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(reattach, delay);
    };

    const run = async () => {
      await waitStableSize(host);
      if (disposed) return;

      const [renderer, wasm] = await Promise.all([
        TerminalRenderer.create(canvas, {
          fontFamily: FONT_FAMILY,
          fontPx: FONT_PX,
          linePad: LINE_PAD,
          dpr,
          bg: palette.bg,
          fg: palette.fg,
          cursor: palette.cursor,
          selectionBg: palette.selectionBg,
          selectionFg: palette.selectionFg,
          onError: (message) => {
            if (!disposed) setStatus({ kind: "failed", reason: message });
          },
        }),
        vtWasm(),
      ]);
      if (disposed) return void renderer.destroy();
      cleanups.push(() => renderer.destroy());
      setBackend(renderer.backendName);

      const { w: cellW, h: cellH } = renderer.cellSize;
      const fit = () => gridFor(host.clientWidth * dpr, host.clientHeight * dpr, cellW, cellH);
      const paint = (cols: number, rows: number) => {
        canvas.style.width = `${(cols * cellW) / dpr}px`;
        canvas.style.height = `${(rows * cellH) / dpr}px`;
      };

      // A hidden pane (inactive sub-tab, restored layout) mounts at zero size; fitting that would
      // create — or worse, SIGWINCH a live session to — a 1x1 grid, garbling every other attached
      // client. Attach at a sane default instead; the ResizeObserver fits it on first reveal.
      const sized = host.clientWidth > 0 && host.clientHeight > 0;
      let { cols, rows } = sized ? fit() : { cols: 80, rows: 24 };
      const core = await VtCore.create(wasm, cols, rows, palette);
      if (disposed) return void core.free();
      cleanups.push(() => core.free());
      paint(cols, rows);

      const sink: PtySink = {
        write: (bytes) => void invoke("session_write", { id, data: Array.from(bytes) }).catch(noop),
        resize: (c, r) => void invoke("session_resize", { id, cols: c, rows: r }).catch(noop),
      };
      const controller = new TerminalController(core, renderer, sink);
      controllerRef.current = controller;

      cleanups.push(
        await listen<number[]>(`session://data/${id}`, (e) =>
          controller.feed(new Uint8Array(e.payload)),
        ),
      );
      cleanups.push(await listen(`session://meta/${id}`, noop));
      cleanups.push(await listen<unknown>(`session://exit/${id}`, (e) => onEnd(toSessionEnd(e.payload))));

      try {
        // Reattach when the named session is already live; create it only when absent, so the
        // terminal survives closing and reopening the pane (the point of a durable host session).
        const existing = await invoke<Array<{ name: string; live: boolean }>>("session_list", {
          socketPath,
          token,
        });
        if (disposed) return;
        const alive = existing.some((s) => s.name === session && s.live);
        await invoke("session_open", {
          id,
          socketPath,
          token,
          session,
          write,
          create: alive || !create ? null : { ...create, cols, rows },
        });
      } catch (e) {
        // The link (not the pane) is the usual culprit — reattach on the same backoff.
        onEnd({ klass: "transport", reason: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (disposed) return;
      // A theme flip can re-run this effect and attach while a retry timer still pends; landing
      // here settles the connection, so a stale timer must not force another remount.
      clearTimeout(retryTimer.current);
      reconnector.current.opened();
      setStatus({ kind: "up" });

      // Tell the pty our real geometry (a fresh session was created at this size; an existing one
      // is resized to the writer's window) — only when we actually have one.
      if (sized) {
        sink.resize(cols, rows);
      }
      const setGeom = () => {
        geomRef.current = { cw: cellW / dpr, ch: cellH / dpr, cols, rows };
      };
      setGeom();

      const observer = new ResizeObserver(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return; // hidden tab
        const next = fit();
        if (next.cols !== cols || next.rows !== rows) {
          cols = next.cols;
          rows = next.rows;
          paint(cols, rows);
          controller.resize(cols, rows);
          controller.setSelection(null); // geometry changed; drop the stale highlight
          setGeom();
        }
      });
      observer.observe(host);
      cleanups.push(() => observer.disconnect());

      const start = performance.now();
      const loop = (now: number) => {
        if (disposed) return;
        // A hidden pane keeps its session and buffers bytes, but burns no GPU: skip the draw and
        // let the accumulated damage paint in one catch-up frame on reveal.
        if (!visibleRef.current) {
          raf = requestAnimationFrame(loop);
          return;
        }
        try {
          controller.frame((now - start) % BLINK_MS < BLINK_ON_MS);
        } catch (e) {
          if (!disposed) setStatus({ kind: "failed", reason: e instanceof Error ? e.message : String(e) });
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    };

    run().catch((e) => {
      // Reaching here means setup (WebGPU, wasm, canvas) failed — retrying won't change it.
      if (!disposed) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("session terminal:", e);
        setStatus({ kind: "failed", reason: message });
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      controllerRef.current = null;
      void invoke("session_close", { id }).catch(noop);
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          /* teardown is best-effort */
        }
      }
    };
    // The session identity — not the one-shot create spec — is the dependency; `epoch` re-dials it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketPath, token, session, write, themeName, epoch]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const controller = controllerRef.current;
    if (!controller) return;
    // While the paste confirmation is up, the keyboard answers the dialog — never the shell. An
    // instinctive Enter or Escape must not land at the prompt behind the modal.
    if (pendingPaste !== null) {
      if (e.key === "Enter") {
        controller.paste(pendingPaste, { force: true });
        setPendingPaste(null);
      } else if (e.key === "Escape") {
        setPendingPaste(null);
      }
      e.preventDefault();
      return;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      if ((e.key === "c" || e.key === "C") && copySelection()) {
        e.preventDefault();
        return;
      }
      if (e.key === "v" || e.key === "V") {
        pasteFromClipboard();
        e.preventDefault();
        return;
      }
      // Cmd chords produce no pty bytes, but a few WebKit defaults would wreck the view over the
      // app DOM (select-all flash, history navigation). Swallow those; everything else stays with
      // the app and the OS (⌘T/⌘D bubble to the pane bar, ⌘Q to the menu).
      if (e.key === "a" || e.key === "A" || e.key.startsWith("Arrow")) {
        e.preventDefault();
      }
      return;
    }
    const consumed = controller.key({
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      caps: e.getModifierState?.("CapsLock") ?? false,
      repeat: e.repeat,
      composing: e.nativeEvent.isComposing,
    });
    if (consumed) {
      controller.setSelection(null); // typing clears the highlight...
      controller.scroll("bottom"); // ...and returns to the live view
      e.preventDefault();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const perLine = e.deltaMode === 1 ? 1 : 24; // line-mode vs ~24px-per-line pixel-mode
    const lines = e.deltaY < 0 ? Math.floor(e.deltaY / perLine) : Math.ceil(e.deltaY / perLine);
    if (lines !== 0) {
      controller.setSelection(null); // the viewport-relative highlight no longer lines up
      controller.scroll({ delta: lines });
    }
  };

  const cellAt = (e: React.PointerEvent): CellPos | null => {
    const canvas = canvasRef.current;
    const g = geomRef.current;
    if (!canvas || !g) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(g.cols - 1, Math.max(0, Math.floor((e.clientX - rect.left) / g.cw)));
    const y = Math.min(g.rows - 1, Math.max(0, Math.floor((e.clientY - rect.top) / g.ch)));
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    hostRef.current?.focus();
    if (e.button !== 0) return;
    const pos = cellAt(e);
    if (!pos) return;
    dragRef.current = pos;
    controllerRef.current?.setSelection(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const anchor = dragRef.current;
    if (!anchor) return;
    const pos = cellAt(e);
    const g = geomRef.current;
    if (!pos || !g) return;
    controllerRef.current?.setSelection(new Selection(anchor, pos, g.cols));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onCompositionEnd = (e: React.CompositionEvent) => {
    const controller = controllerRef.current;
    if (!controller || !e.data) return;
    controller.setSelection(null);
    controller.scroll("bottom");
    controller.text(e.data);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (text) {
      tryPaste(text);
      e.preventDefault();
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    hostRef.current?.focus();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const overlay = overlayFor(status);

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCompositionEnd={onCompositionEnd}
      onPaste={onPaste}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "grid",
        placeItems: "center",
        outline: "none",
        background: bgCss,
      }}
    >
      <canvas ref={canvasRef} />
      {backend && !overlay && (
        <div
          style={{
            position: "absolute",
            right: "8px",
            bottom: "6px",
            font: '10px "JetBrains Mono", ui-monospace, monospace',
            letterSpacing: "0.08em",
            color: backend === "webgpu" ? "#4de0c8" : "#e0a24d",
            opacity: 0.5,
            pointerEvents: "none",
          }}
        >
          {backend.toUpperCase()}
        </div>
      )}
      {overlay && (
        <div className="term-overlay">
          <div className="term-overlay__card">
            <div className={`term-overlay__title term-overlay__title--${overlay.tone}`}>
              {overlay.spin && <span className="term-overlay__spinner" aria-hidden />}
              {overlay.title}
            </div>
            {overlay.reason && <div className="term-overlay__reason">{overlay.reason}</div>}
            {overlay.action && (
              <button type="button" className="term-overlay__btn" onClick={revive}>
                {overlay.action}
              </button>
            )}
          </div>
        </div>
      )}
      {pendingPaste !== null && (
        <div className="term-overlay">
          <div className="term-overlay__card">
            <div className="term-overlay__title term-overlay__title--warn">
              Paste {lineCount(pendingPaste)} lines? Each will run as a command.
            </div>
            <div className="term-overlay__reason">{previewOf(pendingPaste)}</div>
            <div className="term-overlay__actions">
              <button
                type="button"
                className="term-overlay__btn term-overlay__btn--ghost"
                onClick={() => setPendingPaste(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="term-overlay__btn"
                onClick={() => {
                  controllerRef.current?.paste(pendingPaste, { force: true });
                  setPendingPaste(null);
                  hostRef.current?.focus();
                }}
              >
                Paste
              </button>
            </div>
          </div>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              kind: "item",
              label: "Copy",
              hint: "⌘C",
              disabled: !controllerRef.current?.selectedText(),
              onSelect: () => void copySelection(),
            },
            {
              kind: "item",
              label: "Paste",
              hint: "⌘V",
              onSelect: pasteFromClipboard,
            },
            ...(menuExtras?.length ? [{ kind: "separator" } as MenuNode, ...menuExtras] : []),
          ]}
        />
      )}
    </div>
  );
});

function lineCount(text: string): number {
  return text.split(/\r\n|[\r\n]/).length;
}

/** The first few lines of a pending paste, elided — enough to recognize, never a wall. */
function previewOf(text: string): string {
  const lines = text.split(/\r\n|[\r\n]/);
  const shown = lines.slice(0, 4).map((l) => (l.length > 80 ? `${l.slice(0, 80)}…` : l));
  return shown.join("\n") + (lines.length > 4 ? `\n… ${lines.length - 4} more` : "");
}

/** The overlay card for a non-up status; null when the terminal should stand alone. */
function overlayFor(
  status: SessionStatus,
): { title: string; reason?: string; action?: string; tone: "warn" | "muted"; spin?: boolean } | null {
  switch (status.kind) {
    case "up":
      return null;
    case "connecting":
      return status.retrying
        ? { title: "Reconnecting…", tone: "warn", spin: true }
        : null;
    case "down":
      return {
        title: "Connection lost — retrying…",
        reason: status.reason,
        action: "Reconnect now",
        tone: "warn",
        spin: true,
      };
    case "ended":
      return {
        title: `Shell ended (${status.reason})`,
        action: "Restart shell",
        tone: "muted",
      };
    case "failed":
      return {
        title: "Terminal failed",
        reason: status.reason,
        action: "Retry",
        tone: "warn",
      };
  }
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Waits until an element has held a positive, unchanging size for two frames (resize-garble guard). */
async function waitStableSize(el: HTMLElement, maxFrames = 30): Promise<void> {
  let lastW = -1;
  let lastH = -1;
  for (let i = 0; i < maxFrames; i++) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0 && w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    await nextFrame();
  }
}
