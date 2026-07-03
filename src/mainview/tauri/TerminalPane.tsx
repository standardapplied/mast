import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon, init, Terminal, type ITheme } from "ghostty-web";
import { useEffect, useRef, useState } from "react";
import type { ThemeName } from "../../shared/types";
import { terminalTheme, type TerminalTheme } from "../ansi";

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

export function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting…");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    let alive = true;
    let term: Terminal | null = null;
    let dataOff: Promise<() => void> | null = null;
    let exitOff: Promise<() => void> | null = null;
    let observer: ResizeObserver | null = null;

    const send = (data: string) =>
      void invoke("terminal_write", { id, data: Array.from(encoder.encode(data)) }).catch(() => {});

    void (async () => {
      await ensureGhostty();
      if (!alive) return;

      const themeName = (document.documentElement.dataset.theme as ThemeName) || "dark";
      term = new Terminal({
        fontSize: 13,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: toGhosttyTheme(terminalTheme(themeName)),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();

      term.onData(send);
      term.onResize(({ cols, rows }) =>
        void invoke("terminal_resize", { id, cols, rows }).catch(() => {}),
      );
      // ghostty-web 0.4 swallows Shift+Tab / Shift+Enter — the sequences Claude
      // Code needs. Intercept and hand-send them (return false = we handled it).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        if (e.key === "Tab" && e.shiftKey) return send("\x1b[Z"), false;
        if (e.key === "Enter" && e.shiftKey) return send("\r"), false;
        return true;
      });

      dataOff = listen<number[]>(`terminal://data/${id}`, (ev) => {
        if (alive && term) term.write(new Uint8Array(ev.payload));
      });
      exitOff = listen(`terminal://exit/${id}`, () => {
        if (alive) setStatus("session closed");
      });

      observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* pane detached mid-resize */
        }
      });
      observer.observe(host);

      await invoke("terminal_open", { id, cols: term.cols, rows: term.rows });
      if (alive && term) {
        setStatus("connected");
        term.focus();
      }
    })().catch((err) => {
      if (alive) setStatus(`failed: ${err}`);
    });

    return () => {
      alive = false;
      observer?.disconnect();
      void invoke("terminal_close", { id }).catch(() => {});
      void dataOff?.then((off) => off());
      void exitOff?.then((off) => off());
      term?.dispose();
    };
  }, []);

  return (
    <div className="terminal-pane">
      <header className="terminal-pane__bar">
        <span className="terminal-pane__title">devbox — ghostty</span>
        <span className="terminal-pane__status">{status}</span>
      </header>
      <div ref={hostRef} className="terminal-pane__screen" />
    </div>
  );
}
