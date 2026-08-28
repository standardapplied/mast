import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ThemeName } from "../../shared/types";
import { classifyEnd, Reconnector, type SessionStatus } from "../terminal/connection";
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
  /** True when this pane's tab is the visible one — take keyboard focus so typing lands here. */
  readonly active?: boolean;
  /** Lifecycle reporting for the tab bar's status cluster. */
  readonly onStatus?: (status: SessionStatus) => void;
}

const noop = () => {};

export const SessionTerminalPane = forwardRef<
  TerminalHandle,
  SessionTerminalProps
>(function SessionTerminalPane(
  { socketPath, token, session, write = true, create, active, onStatus },
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
  const [backend, setBackend] = useState<string>("");
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

  // Drop-to-paste routes through here; the pane refits itself from its own ResizeObserver, so the
  // workbench's post-splitter-drag refit is a no-op.
  useImperativeHandle(
    ref,
    () => ({
      paste: (text: string) => controllerRef.current?.paste(text),
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
      if (s.kind === "up") {
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
    const onEnd = (reason: string) => {
      if (disposed) return;
      if (classifyEnd(reason) === "clean") {
        setStatus({ kind: "ended", reason });
        return;
      }
      const delay = reconnector.current.lost();
      setStatus({ kind: "down", reason });
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        setStatus({ kind: "connecting", retrying: true });
        setEpoch((e) => e + 1);
      }, delay);
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

      let { cols, rows } = fit();
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
      cleanups.push(await listen<string>(`session://exit/${id}`, (e) => onEnd(e.payload)));

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
        onEnd(`transport error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (disposed) return;
      reconnector.current.opened();
      setStatus({ kind: "up" });

      // Tell the pty our real geometry (a fresh session was created at this size; an existing one
      // is resized to the writer's window).
      sink.resize(cols, rows);
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
    if (e.metaKey && (e.key === "c" || e.key === "C")) {
      const text = controller.selectedText();
      if (text) {
        void navigator.clipboard?.writeText(text).catch(() => {});
        e.preventDefault();
        return;
      }
    }
    const consumed = controller.key({
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
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

  const onPaste = (e: React.ClipboardEvent) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const text = e.clipboardData.getData("text");
    if (text) {
      controller.scroll("bottom");
      controller.paste(text);
      e.preventDefault();
    }
  };

  const overlay = overlayFor(status);

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
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
    </div>
  );
});

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
