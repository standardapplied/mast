import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon, init, Terminal, type ITheme } from "ghostty-web";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ThemeName } from "../../shared/types";
import { terminalTheme, type TerminalTheme } from "../ansi";

export type TerminalHandle = { paste: (text: string) => void };

/**
 * The terminal pillar: a real Ghostty VT (WASM) rendering a live PTY on the
 * devbox over the in-process russh session. Bytes arrive as Tauri events and
 * are handed to ghostty for parsing/rendering; keystrokes and resizes go back
 * over `invoke`. ghostty owns the escape-sequence handling the raw harness
 * couldn't — colors, cursor, scrollback, alt-screen.
 */

// ghostty's WASM parser initialises once per document; share the promise.
let ghosttyReady: Promise<void> | null = null;
const ensureGhostty = () => (ghosttyReady ??= init());

function toGhosttyTheme(t: TerminalTheme): ITheme {
  const [
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  ] = t.ansi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    selectionBackground: t.selectionBackground,
    selectionForeground: t.selectionForeground,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}

export const TerminalPane = forwardRef<
  TerminalHandle,
  {
    /** ssh alias of a project container; omitted = a shell on the node. */
    target?: string;
    label?: string;
    /** True when this pane's tab is the visible one — focus the shell. */
    active?: boolean;
  }
>(function TerminalPane({ target, label, active }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef("");
  const [status, setStatus] = useState("connecting…");

  // Auto-focus the emulator when this tab becomes active, so you can type
  // immediately without clicking in. rAF lets the display flip apply first.
  useEffect(() => {
    if (active) requestAnimationFrame(() => termRef.current?.focus());
  }, [active]);

  const write = (data: string) =>
    void invoke("terminal_write", {
      id: idRef.current,
      data: Array.from(new TextEncoder().encode(data)),
    }).catch(() => {});

  // Lets the drop coordinator inject an uploaded file's path into the shell.
  useImperativeHandle(ref, () => ({ paste: (text) => idRef.current && write(text) }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const id = crypto.randomUUID();
    idRef.current = id;
    const encoder = new TextEncoder();
    let alive = true;
    let dataOff: Promise<() => void> | null = null;
    let exitOff: Promise<() => void> | null = null;
    let observer: ResizeObserver | null = null;

    const send = (data: string) =>
      void invoke("terminal_write", { id, data: Array.from(encoder.encode(data)) }).catch(() => {});
    let doFit = () => {};
    let fitScheduled = false;
    const scheduleFit = () => {
      if (fitScheduled) return;
      fitScheduled = true;
      requestAnimationFrame(() => {
        fitScheduled = false;
        doFit();
      });
    };

    void (async () => {
      await ensureGhostty();
      if (!alive) return;

      const themeName = (document.documentElement.dataset.theme as ThemeName) || "dark";
      const term = new Terminal({
        fontSize: 13,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: toGhosttyTheme(terminalTheme(themeName)),
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      doFit = () => {
        try {
          fit.fit();
        } catch {
          /* pane detached / metrics not ready */
        }
      };
      doFit();

      term.onData(send);
      term.onResize(({ cols, rows }) =>
        void invoke("terminal_resize", { id, cols, rows }).catch(() => {}),
      );
      // ghostty-web 0.4 returns truthy from customKeyEventHandler = "consume +
      // preventDefault". So return false to let ghostty encode normal keys
      // (otherwise every keystroke is swallowed); return true only for the keys
      // it mishandles (Shift+Tab / Shift+Enter), which we hand-send for Claude.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return false;
        if (e.key === "Tab" && e.shiftKey) return send("\x1b[Z"), true;
        if (e.key === "Enter" && e.shiftKey) return send("\r"), true;
        return false;
      });

      dataOff = listen<number[]>(`terminal://data/${id}`, (ev) => {
        if (alive && termRef.current) termRef.current.write(new Uint8Array(ev.payload));
      });
      exitOff = listen(`terminal://exit/${id}`, () => {
        if (alive) setStatus("session closed");
      });

      // Keep the PTY sized to the pane. Coalesce fits onto a frame so a burst
      // of resize events settles to one measure after layout has updated.
      observer = new ResizeObserver(scheduleFit);
      observer.observe(host);
      window.addEventListener("resize", scheduleFit);
      // The first synchronous fit can run before layout/fonts settle; re-fit a
      // few times so the grid ends up matching the real pane size.
      void document.fonts?.ready.then(() => alive && doFit());
      for (const t of [0, 200, 500]) setTimeout(() => alive && doFit(), t);

      await invoke("terminal_open", { id, target: target ?? null, cols: term.cols, rows: term.rows });
      if (alive) {
        setStatus("connected");
        term.focus();
      }
    })().catch((err) => {
      if (alive) setStatus(`failed: ${err}`);
    });

    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleFit);
      void invoke("terminal_close", { id }).catch(() => {});
      void dataOff?.then((off) => off());
      void exitOff?.then((off) => off());
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  const connState =
    status === "connected" ? "connected" : status === "connecting…" ? "connecting" : "off";

  return (
    <div className="terminal-pane">
      <div
        ref={hostRef}
        className="terminal-pane__screen"
        onMouseDown={() => termRef.current?.focus()}
      />
      <footer className="terminal-pane__statusbar">
        <span className="terminal-pane__label">{label ?? target ?? "node · devbox"}</span>
        <span className="terminal-pane__conn" data-state={connState}>
          <span className="terminal-pane__dot" />
          {status}
        </span>
      </footer>
    </div>
  );
});
