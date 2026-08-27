import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { TerminalRenderer } from "../terminal/renderer";
import { gridFor, type PtySink, TerminalController } from "../terminal/terminalController";
import { VtCore } from "../terminal/vtCore";

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
}

const noop = () => {};

export function SessionTerminalPane({
  socketPath,
  token,
  session,
  write = true,
  create,
}: SessionTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

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
        }),
        vtWasm(),
      ]);
      if (disposed) return void renderer.destroy();
      cleanups.push(() => renderer.destroy());

      const { w: cellW, h: cellH } = renderer.cellSize;
      const fit = () => gridFor(host.clientWidth * dpr, host.clientHeight * dpr, cellW, cellH);
      const paint = (cols: number, rows: number) => {
        canvas.style.width = `${(cols * cellW) / dpr}px`;
        canvas.style.height = `${(rows * cellH) / dpr}px`;
      };

      let { cols, rows } = fit();
      const core = await VtCore.create(wasm, cols, rows);
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
      cleanups.push(await listen<string>(`session://exit/${id}`, noop));

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

      const start = performance.now();
      const loop = (now: number) => {
        if (disposed) return;
        controller.frame((now - start) % BLINK_MS < BLINK_ON_MS);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    };

    run().catch((e) => {
      if (!disposed) console.error("session terminal:", e);
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
    if (consumed) e.preventDefault();
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
      style={{
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
    </div>
  );
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
