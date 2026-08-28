import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { TerminalRenderer } from "../terminal/renderer";
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
 */

const FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", monospace';
const FONT_PX = 15;
const LINE_PAD = 0.25;
const BLINK_MS = 1060;
const BLINK_ON_MS = 600;

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
}

const noop = () => {};

export const SessionTerminalPane = forwardRef<
  TerminalHandle,
  SessionTerminalProps
>(function SessionTerminalPane({ socketPath, token, session, write = true, create, active }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const coreRef = useRef<VtCore | null>(null);
  const feedRef = useRef({ chunks: 0, bytes: 0, recent: [] as number[] });
  const sentRef = useRef({ keys: 0, writes: 0, err: "" });
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>("");
  const [probe, setProbe] = useState<string>("");

  // Drop-to-paste routes through here; the pane refits itself from its own ResizeObserver, so the
  // workbench's post-splitter-drag refit is a no-op.
  useImperativeHandle(
    ref,
    () => ({
      paste: (text: string) => controllerRef.current?.paste(text),
      refit: () => {},
    }),
    [],
  );

  // Take keyboard focus when this pane's tab becomes the visible one, so keystrokes land in the
  // terminal instead of being dropped on an unfocused div (the old xterm pane focused itself).
  useEffect(() => {
    if (active !== false) hostRef.current?.focus();
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    setError(null);
    let disposed = false;
    let raf = 0;
    const cleanups: Array<() => void> = [];
    const id = crypto.randomUUID();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const run = async () => {
      await waitStableSize(host);
      if (disposed) return;

      const [renderer, wasm] = await Promise.all([
        TerminalRenderer.create(canvas, {
          fontFamily: FONT_FAMILY,
          fontPx: FONT_PX,
          linePad: LINE_PAD,
          dpr,
          onError: (message) => {
            if (!disposed) setError(message);
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
      const core = await VtCore.create(wasm, cols, rows);
      if (disposed) return void core.free();
      coreRef.current = core;
      cleanups.push(() => core.free());
      paint(cols, rows);

      const sink: PtySink = {
        write: (bytes) =>
          void invoke("session_write", { id, data: Array.from(bytes) })
            .then(() => {
              sentRef.current.writes += 1;
            })
            .catch((e) => {
              sentRef.current.err = e instanceof Error ? e.message : String(e);
            }),
        resize: (c, r) => void invoke("session_resize", { id, cols: c, rows: r }).catch(noop),
      };
      const controller = new TerminalController(core, renderer, sink);
      controllerRef.current = controller;

      cleanups.push(
        await listen<number[]>(`session://data/${id}`, (e) => {
          const bytes = new Uint8Array(e.payload);
          const f = feedRef.current;
          f.chunks += 1;
          f.bytes += bytes.length;
          for (const b of bytes) f.recent.push(b);
          if (f.recent.length > 64) f.recent.splice(0, f.recent.length - 64);
          controller.feed(bytes);
        }),
      );
      cleanups.push(await listen(`session://meta/${id}`, noop));
      cleanups.push(
        await listen<string>(`session://exit/${id}`, (e) => {
          if (!disposed) setError(e.payload);
        }),
      );

      // Reattach when the named session is already live; create it only when absent, so the
      // terminal survives closing and reopening the pane (the point of a durable host session).
      const existing = await invoke<Array<{ name: string; live: boolean }>>("session_list", {
        socketPath,
        token,
      }).catch(() => [] as Array<{ name: string; live: boolean }>);
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
      // Tell the pty our real geometry (a fresh session was created at this size; an existing one
      // is resized to the writer's window).
      sink.resize(cols, rows);

      const observer = new ResizeObserver(() => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return; // hidden tab
        const next = fit();
        if (next.cols !== cols || next.rows !== rows) {
          cols = next.cols;
          rows = next.rows;
          paint(cols, rows);
          controller.resize(cols, rows);
        }
      });
      observer.observe(host);
      cleanups.push(() => observer.disconnect());

      const asChar = (b: number) =>
        b === 10 ? "\\n" : b === 13 ? "\\r" : b === 27 ? "^[" : b >= 32 && b < 127 ? String.fromCharCode(b) : "·";
      const debug = window.setInterval(() => {
        if (disposed) return;
        const f = feedRef.current;
        const cur = core.cursor();
        let rowText = "";
        try {
          const row = core.viewportRows().find((r) => r.y === cur.y);
          if (row) {
            rowText = row.cells
              .map((c) => (c.text === "" ? " " : c.text))
              .join("")
              .replace(/\s+$/, "");
          }
        } catch {
          /* probe is best-effort */
        }
        const s = sentRef.current;
        const focused = document.activeElement === host;
        setProbe(
          `fed ${f.chunks}ch/${f.bytes}b  sent ${s.keys}k/${s.writes}w  focus ${focused ? "Y" : "N"}  cur ${cur.x},${cur.y}  ${cols}x${rows}\n` +
            `${s.err ? `writeErr: ${s.err}\n` : ""}` +
            `recent: ${f.recent.map(asChar).join("")}\n` +
            `vtRow[${cur.y}]: ${rowText.slice(0, 90)}`,
        );
      }, 300);
      cleanups.push(() => window.clearInterval(debug));

      const start = performance.now();
      const loop = (now: number) => {
        if (disposed) return;
        try {
          controller.frame((now - start) % BLINK_MS < BLINK_ON_MS);
        } catch (e) {
          if (!disposed) setError(e instanceof Error ? e.message : String(e));
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    };

    run().catch((e) => {
      if (!disposed) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("session terminal:", e);
        setError(message);
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
    // The session identity — not the one-shot create spec — is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketPath, token, session, write]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const consumed = controller.key({
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
    });
    if (consumed) {
      sentRef.current.keys += 1;
      e.preventDefault();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const text = e.clipboardData.getData("text");
    if (text) {
      controller.paste(text);
      e.preventDefault();
    }
  };

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onPointerDown={() => hostRef.current?.focus()}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "grid",
        placeItems: "center",
        outline: "none",
        background: "#0b0e14",
      }}
    >
      <canvas ref={canvasRef} />
      {probe && (
        <pre
          style={{
            position: "absolute",
            left: "6px",
            top: "6px",
            margin: 0,
            padding: "6px 8px",
            font: '11px/1.4 "JetBrains Mono", ui-monospace, monospace',
            color: "#7dd3fc",
            background: "rgba(0,0,0,0.72)",
            border: "1px solid #164e63",
            borderRadius: "4px",
            whiteSpace: "pre-wrap",
            maxWidth: "min(90%, 900px)",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          {probe}
        </pre>
      )}
      {backend && (
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
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            padding: "24px",
            background: "#0b0e14",
            color: "#e0a24d",
            font: '13px/1.6 "JetBrains Mono", ui-monospace, monospace',
            textAlign: "center",
            whiteSpace: "pre-wrap",
            maxWidth: "640px",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
});

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
