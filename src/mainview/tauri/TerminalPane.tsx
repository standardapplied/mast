import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon, init, Terminal, type ITheme } from "ghostty-web";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ThemeName } from "../../shared/types";
import { logError } from "../errorLog";
import { terminalTheme, type TerminalTheme } from "../ansi";
import { KITTY_DISAMBIGUATE, KittyKeyboardBridge, shiftEnterSequence } from "./kittyKeyboard";

export type TerminalHandle = {
  paste: (text: string) => void;
  /** Refit the VT to the pane's *settled* size — a splitter drag resizes the
   *  host without a window resize, and fitting at a stale mid-drag size
   *  garbles the PTY geometry. */
  refit: () => void;
  /** Reattach a dead link now, or restart an ended shell (durable session panes only). */
  revive?: () => void;
};

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

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Resolve once the element's box has stopped changing across two consecutive
 * frames (or a cap). A tab reopened via the picker mounts into a still-settling
 * flex layout; opening the PTY before the size is final makes the shell's first
 * output (which arrives instantly on a cached SSH session) print at the wrong
 * column count — the reopen garble. Waiting for a stable size fixes it.
 */
async function waitStableSize(el: HTMLElement, maxFrames = 40): Promise<void> {
  let last = -1;
  for (let i = 0; i < maxFrames; i++) {
    await nextFrame();
    const size = el.clientWidth * 100000 + el.clientHeight;
    if (el.clientWidth > 0 && size === last) return;
    last = size;
  }
}

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
  const fitRef = useRef<FitAddon | null>(null);
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

  // Lets the drop coordinator inject an uploaded file's path into the shell,
  // and the workbench splitters refit the VT after a pane resize settles.
  useImperativeHandle(
    ref,
    () => ({
      paste: (text) => idRef.current && write(text),
      refit: () => {
        const host = hostRef.current;
        if (!host || !fitRef.current) return;
        void waitStableSize(host).then(() => {
          try {
            fitRef.current?.fit();
          } catch {
            /* metrics not ready */
          }
        });
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const id = crypto.randomUUID();
    idRef.current = id;
    const encoder = new TextEncoder();
    let alive = true;
    let dataOff: Promise<() => void> | null = null;
    let exitOff: Promise<() => void> | null = null;
    let fitAddon: FitAddon | null = null;
    let onWinResize: (() => void) | null = null;

    const send = (data: string) =>
      void invoke("terminal_write", { id, data: Array.from(encoder.encode(data)) }).catch(() => {});
    const kitty = new KittyKeyboardBridge();

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
      fitAddon = fit;
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(host);

      // A reopened tab mounts into a still-settling flex layout; wait for the
      // pane box to stop changing so the one fit measures the real size (a fit
      // at a stale size opens the PTY at the wrong column count → the shell's
      // first output, instant on a cached SSH session, renders garbled). Then
      // hand resizing to the addon's own DEBOUNCED observer, so a settling burst
      // can't reflow the PTY mid-banner (an eager per-frame observer did).
      await waitStableSize(host);
      if (!alive) return;
      try {
        fit.fit();
      } catch {
        /* metrics not ready — the observer will fit shortly */
      }

      term.onData(send);
      term.onResize(({ cols, rows }) =>
        void invoke("terminal_resize", { id, cols, rows }).catch(() => {}),
      );
      // ghostty-web 0.4 returns truthy from customKeyEventHandler = "consume +
      // preventDefault". So return false to let ghostty encode normal keys
      // (otherwise every keystroke is swallowed); return true only for the keys
      // it mishandles (Shift+Tab / Shift+Enter), which we hand-send. Shift+Enter
      // must insert a newline in Claude Code / Codex, never submit — see
      // shiftEnterSequence for both encodings. The first fallback press is
      // logged so diagnostics shows kitty keys never negotiated in this pane.
      let fallbackLogged = false;
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return false;
        if (e.key === "Tab" && e.shiftKey) return send("\x1b[Z"), true;
        if (e.key === "Enter" && e.shiftKey) {
          if (!(kitty.flags & KITTY_DISAMBIGUATE) && !fallbackLogged) {
            fallbackLogged = true;
            logError("term", `${target ?? "node"}: shift+enter used ESC-CR fallback (kitty keys not negotiated)`);
          }
          return send(shiftEnterSequence(kitty.flags)), true;
        }
        return false;
      });
      // Wheel scrolling. In the normal buffer (the agent's streaming conversation)
      // scroll our own scrollback. In the alternate screen (Claude Code's full-screen
      // TUI, vim, …) there is no local scrollback, and ghostty's default translates
      // the wheel into ARROW keys — which Claude Code reads as input-history nav, not
      // scroll ("Scroll wheel is sending arrow keys"). Send PgUp/PgDn instead — the
      // keys these TUIs actually scroll with — accumulated so a trackpad's fine
      // deltas don't fly through whole pages at once.
      let wheelAccum = 0;
      term.attachCustomWheelEventHandler((e) => {
        if (term.buffer.active.type !== "alternate") {
          term.scrollLines(e.deltaY > 0 ? 3 : -3);
          return true;
        }
        const STEP = 100;
        wheelAccum += e.deltaY;
        while (wheelAccum >= STEP) {
          send("\x1b[6~"); // Page Down
          wheelAccum -= STEP;
        }
        while (wheelAccum <= -STEP) {
          send("\x1b[5~"); // Page Up
          wheelAccum += STEP;
        }
        return true;
      });

      dataOff = listen<number[]>(`terminal://data/${id}`, (ev) => {
        if (!alive || !termRef.current) return;
        const data = new Uint8Array(ev.payload);
        const reply = kitty.feed(data);
        if (reply) send(reply);
        termRef.current.write(data);
      });
      exitOff = listen(`terminal://exit/${id}`, () => {
        if (alive) setStatus("session closed");
      });

      fit.observeResize();
      onWinResize = () => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("resize", onWinResize);

      const negotiatedTerm = await invoke<string>("terminal_open", {
        id,
        target: target ?? null,
        cols: term.cols,
        rows: term.rows,
      });
      if (negotiatedTerm !== "xterm-ghostty") {
        logError("term", `${target ?? "node"}: TERM degraded to ${negotiatedTerm} (terminfo install failed)`);
      }
      if (alive) {
        setStatus("connected");
        term.focus();
        // The very first output can print before the column count settles (a
        // reopened tab garbles until it does). Once it has, ask the shell to
        // redraw the prompt cleanly — same effect as typing Ctrl-L / `clear`.
        setTimeout(() => alive && send("\x0c"), 500);
      }
    })().catch((err) => {
      if (alive) setStatus(`failed: ${err}`);
    });

    return () => {
      alive = false;
      if (onWinResize) window.removeEventListener("resize", onWinResize);
      fitRef.current = null;
      fitAddon?.dispose();
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
