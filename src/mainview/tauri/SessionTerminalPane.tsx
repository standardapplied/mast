import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ThemeName } from "../../shared/types";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import {
  absenceReason,
  type EndedDisposition,
  type HostListing,
  Reconnector,
  resolveTransportEnd,
  type SessionEnd,
  type SessionStatus,
  toSessionEnd,
} from "../terminal/connection";
import {
  TERMINAL_FONT_FAMILY as FONT_FAMILY,
  TERMINAL_FONT_PX as FONT_PX,
  TERMINAL_PAD_X as PAD_X,
  TERMINAL_PAD_Y as PAD_Y,
} from "../terminal/metrics";
import { preAttachClass, skewCard, skewOf } from "../terminal/roomDeck";
import { TerminalRenderer } from "../terminal/renderer";
import { type CellPos, Selection } from "../terminal/selection";
import { decodeDataFrame } from "../terminal/dataFrames";
import { MODS } from "../terminal/input";
import { paletteFor, resolveThemeName } from "../terminal/terminalPalette";
import { gridFor, type PtySink, TerminalController } from "../terminal/terminalController";
import { type MouseButton, VtCore } from "../terminal/vtCore";
/** What a mounted terminal offers its host: paste routing, refit, and connection recovery. */
export type TerminalHandle = {
  paste: (text: string) => void;
  /** Refit the VT to the pane's *settled* size — a splitter drag resizes the
   *  host without a window resize, and fitting at a stale mid-drag size
   *  garbles the PTY geometry. */
  refit: () => void;
  /** Reattach a dead link now, skipping any scheduled backoff. */
  revive?: () => void;
  /** Claim the write token; the grant arrives as the host's WriterChanged broadcast. */
  takeWrite?: () => void;
};

/**
 * SessionTerminalPane — a durable, host-owned pty rendered by our own WebGPU terminal.
 *
 * This is the transport edge: it owns a canvas, wires the pure {@link TerminalController} (VtCore +
 * renderer + a Tauri-backed {@link PtySink}) to the `session_*` commands and `session://` events,
 * and runs the frame loop. All terminal logic lives in the tested `terminal/` modules; this file
 * only bridges them to the live IPC host, so it is the untested, Mac-verified surface — kept thin.
 *
 * Connection lifecycle: the host session outlives any one link, so a dead transport (lid close,
 * network change, keepalive timeout) auto-reattaches on the {@link Reconnector}'s backoff — after
 * ONE reconcile listing proves the session still lives; a session the host no longer lists ended
 * (or the host restarted), and reads as such instead of as a link problem — plus
 * immediately when the window becomes visible or the network returns. A shell that exited is a
 * different matter: the pane reports `ended` and its host decides — it leaves the layout, or parks
 * on the scope's ended card. A create spec is spent on the first attach: a reattach never creates.
 */

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

/** What the terminal answers to XTVERSION (CSI > q); resolved once. */
let identityPromise: Promise<string> | null = null;
function mastIdentity(): Promise<string> {
  identityPromise ??= getVersion().then(
    (version) => `mast ${version}`,
    () => "mast",
  );
  return identityPromise;
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
  /** Bind the session to a room; the host gates admission and refuses verbatim. */
  readonly room?: string;
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
  /** The shell announced its title (OSC 0/2) — the pane's default display name. */
  readonly onTitle?: (title: string) => void;
  /** The write token moved (the host's WriterChanged broadcast); "" means released. */
  readonly onWriter?: (fde: string) => void;
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
  {
    socketPath,
    token,
    session,
    write = true,
    create,
    active,
    visible = true,
    onStatus,
    menuExtras,
    onTitle,
    onWriter,
  },
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
  const activeRef = useRef(active !== false);
  activeRef.current = active !== false;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onWriterRef = useRef(onWriter);
  onWriterRef.current = onWriter;
  const attachIdRef = useRef<string | null>(null);
  /** The host boot id this pane last saw the session listed under (see absenceReason). */
  const seenUnderRef = useRef<string | null>(null);
  /** True once the create spec has been spent — a reattach attaches, never recreates. */
  const createdRef = useRef(false);
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
   * The one recovery verb: reattach a dead link now, skipping any scheduled backoff. An ended
   * shell is not revived here — the pane's host decides what an ending means (the pane leaves the
   * layout, or parks on its scope's ended card whose Restart mints a fresh session).
   */
  const revive = useCallback(() => {
    reconnector.current.reset();
    reattach();
  }, [reattach]);

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
      takeWrite: () => {
        const id = attachIdRef.current;
        if (id) void invoke("session_take_write", { id }).catch(noop);
      },
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

  // Focus is a fact of the DOM, not a prop: the cursor reads as focused, and apps that asked for
  // focus reports (mode 1004) hear CSI I/O, exactly when keystrokes would reach this pane — the
  // host element holds focus and the window is frontmost. Anything else (a hidden view that kept
  // its "active" prop, a button in an overlay, a backgrounded window) reads as unfocused.
  const hasFocusRef = useRef(false);
  const reportedFocusRef = useRef<boolean | null>(null);
  const syncFocus = useCallback(() => {
    const host = hostRef.current;
    const focused = host !== null && document.hasFocus() && document.activeElement === host;
    hasFocusRef.current = focused;
    // The initial state is never reported: an attach is assumed focused, and a replay end
    // corrects an unfocused far side of a split.
    if (reportedFocusRef.current !== null && reportedFocusRef.current !== focused) {
      controllerRef.current?.setFocus(focused);
    }
    reportedFocusRef.current = focused;
  }, []);
  useEffect(() => {
    window.addEventListener("blur", syncFocus);
    window.addEventListener("focus", syncFocus);
    return () => {
      window.removeEventListener("blur", syncFocus);
      window.removeEventListener("focus", syncFocus);
    };
  }, [syncFocus]);

  // Take keyboard focus whenever this pane becomes the visible, active one — its tab selected,
  // its view brought back on screen, a reconnect — so keystrokes land in the terminal instead of
  // wherever the previous view left them. A hidden element cannot take focus, hence `visible`.
  useEffect(() => {
    if (active !== false && visible) hostRef.current?.focus();
  }, [active, visible, epoch]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let disposed = false;
    let raf = 0;
    const cleanups: Array<() => void> = [];
    const id = crypto.randomUUID();
    attachIdRef.current = id;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    /**
     * The session is over for this attach; decide between auto-reattach and parking. An ending
     * the host delivered as the shell's own exit closes the pane; one this pane inferred from a
     * listing (the session is gone) parks it on its card — see {@link EndedDisposition}.
     */
    const park = (end: SessionEnd, disposition: EndedDisposition = "close-pane") => {
      if (disposed) return;
      if (end.klass === "ended") {
        setStatus({ kind: "ended", reason: end.reason, disposition });
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

    /**
     * A transport drop takes one reconcile listing before any backoff: the session listed live
     * is a genuine link loss; absent or dead, it ended and must never be retried into. The
     * listing failing means the link itself is down — the reconnect path's own case.
     */
    const onEnd = (end: SessionEnd) => {
      if (disposed) return;
      if (end.klass !== "transport") return park(end);
      void invoke<HostListing>("session_list", { socketPath, token })
        .then(
          (listing) => listing,
          () => null,
        )
        .then((listing) =>
          park(resolveTransportEnd(end, session, seenUnderRef.current, listing), "park-card"),
        );
    };

    const run = async () => {
      await waitStableSize(host);
      if (disposed) return;

      const [renderer, wasm] = await Promise.all([
        TerminalRenderer.create(canvas, {
          fontFamily: FONT_FAMILY,
          fontPx: FONT_PX,
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

      const { w: cellW, h: cellH } = renderer.cellSize;
      const fit = () =>
        gridFor(
          (host.clientWidth - 2 * PAD_X) * dpr,
          (host.clientHeight - 2 * PAD_Y) * dpr,
          cellW,
          cellH,
        );
      const paint = (cols: number, rows: number) => {
        canvas.style.width = `${(cols * cellW) / dpr}px`;
        canvas.style.height = `${(rows * cellH) / dpr}px`;
      };

      // A hidden pane (inactive sub-tab, restored layout) mounts at zero size; fitting that would
      // create — or worse, SIGWINCH a live session to — a 1x1 grid, garbling every other attached
      // client. Attach at a sane default instead; the ResizeObserver fits it on first reveal.
      const sized = host.clientWidth > 0 && host.clientHeight > 0;
      let { cols, rows } = sized ? fit() : { cols: 80, rows: 24 };
      const core = await VtCore.create(wasm, cols, rows, palette, {
        identity: await mastIdentity(),
        scheme: themeName === "light" ? "light" : "dark",
      });
      if (disposed) return void core.free();
      cleanups.push(() => core.free());
      core.setCellPixels(cellW, cellH);
      paint(cols, rows);

      const sink: PtySink = {
        // Raw body, id in a header: no JSON number array per keystroke byte.
        write: (bytes) =>
          void invoke("session_write", bytes, { headers: { "x-mast-session": id } }).catch(noop),
        resize: (c, r) => void invoke("session_resize", { id, cols: c, rows: r }).catch(noop),
      };
      const controller = new TerminalController(core, renderer, sink);
      controllerRef.current = controller;

      controller.hooks.onClipboard = (text) =>
        void navigator.clipboard?.writeText(text).catch(noop);
      controller.hooks.onTitle = (title) => onTitleRef.current?.(title);
      // One ordered raw channel carries bytes AND replay markers: a mid-stream replay means the
      // host dropped part of the stream (flow-control pause) and is re-baselining us — the
      // terminal resets so the snapshot lands clean, then snaps back to the live view.
      const onData = new Channel<ArrayBuffer>();
      onData.onmessage = (message) => {
        if (disposed) return;
        const frame = decodeDataFrame(message);
        if (frame.kind === "bytes") {
          controller.feed(frame.data);
        } else if (frame.kind === "replay-begin") {
          controller.resetForReplay();
        } else {
          controller.endReplay();
          controller.scroll("bottom");
          // The replay just restored the app's modes; a pane without keyboard focus owes it a
          // focus-lost report (the attach itself is assumed focused, which is wrong for a split's
          // far side or a view that is not on screen).
          if (!hasFocusRef.current) {
            controller.setFocus(false);
          }
        }
      };
      cleanups.push(
        await listen<{ kind: string; fde?: string }>(`session://meta/${id}`, (e) => {
          if (e.payload.kind === "writer_changed") {
            onWriterRef.current?.(e.payload.fde ?? "");
          }
        }),
      );
      cleanups.push(await listen<unknown>(`session://exit/${id}`, (e) => onEnd(toSessionEnd(e.payload))));

      try {
        // Reattach when the named session is already live; create it only when the host asked
        // for a create (a launch). Absent with no create is an ending to report — never a
        // silent recreate, and never a refusal to retry into.
        const listing = await invoke<HostListing>("session_list", { socketPath, token });
        if (disposed) return;
        const alive = listing.sessions.some((s) => s.name === session && s.live);
        const spec = createdRef.current ? undefined : create;
        if (!alive && !spec) {
          park(
            { klass: "ended", reason: absenceReason(seenUnderRef.current, listing.hostBootId) },
            "park-card",
          );
          return;
        }
        seenUnderRef.current = listing.hostBootId;
        // Resolves only once the host has acknowledged Create and Attach: a link that drops
        // before that keeps the create for the next attempt, since nothing was created.
        await invoke("session_open", {
          id,
          socketPath,
          token,
          session,
          write,
          create: alive || !spec ? null : { ...spec, cols, rows },
          onData,
        });
        createdRef.current = true;
      } catch (e) {
        // An open rejects with the same `{class, reason}` an ending carries; a listing rejects
        // with a bare message. The link (not the pane) is the usual culprit and reattaches on
        // the same backoff — but a protocol skew parks on the skew card instead of retrying.
        const end = toSessionEnd(e instanceof Error ? e.message : e);
        onEnd(end.klass === "transport" ? { ...end, klass: preAttachClass(end.reason) } : end);
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
          // The blink phase applies only when the app wants a blinking cursor; an unfocused pane
          // shows a steady hollow cursor.
          controller.frame((now - start) % BLINK_MS < BLINK_ON_MS, hasFocusRef.current);
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

  /** The button an application is hearing about while it is held; null while none is. */
  const heldButtonRef = useRef<MouseButton | null>(null);

  const modsOf = (e: React.MouseEvent) =>
    (e.shiftKey ? MODS.SHIFT : 0) |
    (e.ctrlKey ? MODS.CTRL : 0) |
    (e.altKey ? MODS.ALT : 0) |
    (e.metaKey ? MODS.SUPER : 0);

  const wheelAccRef = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    const controller = controllerRef.current;
    if (!controller) return;
    // Pixel-accurate: accumulate deltas and emit a line only when a full cell height has passed.
    // The old round-every-event-to-a-line turned each trackpad tick into a whole line, which read
    // as far too fast; this tracks the finger 1:1.
    const cellH = geomRef.current?.ch ?? 20;
    wheelAccRef.current += e.deltaMode === 1 ? e.deltaY * cellH : e.deltaY;
    const lines = Math.trunc(wheelAccRef.current / cellH);
    if (lines !== 0) {
      wheelAccRef.current -= lines * cellH;
      controller.setSelection(null); // the viewport-relative highlight no longer lines up
      controller.wheel(lines, cellAt(e) ?? undefined, modsOf(e));
    }
  };

  const cellAt = (e: { clientX: number; clientY: number }): CellPos | null => {
    const canvas = canvasRef.current;
    const g = geomRef.current;
    if (!canvas || !g) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(g.cols - 1, Math.max(0, Math.floor((e.clientX - rect.left) / g.cw)));
    const y = Math.min(g.rows - 1, Math.max(0, Math.floor((e.clientY - rect.top) / g.ch)));
    return { x, y };
  };

  /** Left and middle buttons may belong to the application; the right button stays Mast's menu. */
  const buttonOf = (e: React.PointerEvent): MouseButton | null =>
    e.button === 0 ? "left" : e.button === 1 ? "middle" : null;

  const onPointerDown = (e: React.PointerEvent) => {
    // Overlay chrome (the context menu, confirm cards) renders inside this host. Capturing the
    // pointer here would retarget its clicks to the host — the menu's Copy/Paste would never fire —
    // and clearing the selection here would empty Copy before it runs. Chrome owns its own clicks;
    // while the paste card is up, a click anywhere in the pane still restores keyboard focus so
    // Enter/Escape answer the dialog.
    if (e.target !== canvasRef.current && e.target !== hostRef.current) {
      if (pendingPaste !== null) hostRef.current?.focus();
      return;
    }
    hostRef.current?.focus();
    const button = buttonOf(e);
    const pos = cellAt(e);
    if (!button || !pos) return;
    const controller = controllerRef.current;
    // An application tracking the mouse gets the press (unless Shift keeps it local); the
    // release and any drag follow it there too, whatever the app does with tracking meanwhile.
    if (controller?.mouse({ action: "press", button, mods: modsOf(e), ...pos })) {
      heldButtonRef.current = button;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (button !== "left") return;
    dragRef.current = pos;
    controller?.setSelection(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pos = cellAt(e);
    if (!pos) return;
    const controller = controllerRef.current;
    const held = heldButtonRef.current;
    if (held || dragRef.current === null) {
      controller?.mouse({ action: "motion", button: held ?? undefined, mods: modsOf(e), ...pos });
      return;
    }
    const g = geomRef.current;
    if (!g) return;
    controller?.setSelection(new Selection(dragRef.current, pos, g.cols));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const held = heldButtonRef.current;
    if (held) {
      heldButtonRef.current = null;
      const pos = cellAt(e);
      if (pos) controllerRef.current?.mouse({ action: "release", button: held, mods: modsOf(e), ...pos });
    }
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
      onFocus={syncFocus}
      onBlur={syncFocus}
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
        padding: `${PAD_Y}px ${PAD_X}px`,
        boxSizing: "border-box",
        outline: "none",
        background: bgCss,
      }}
    >
      <canvas ref={canvasRef} />
      {overlay && (
        <div className={overlay.delayed ? "term-overlay term-overlay--delayed" : "term-overlay"}>
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
function overlayFor(status: SessionStatus): {
  title: string;
  reason?: string;
  action?: string;
  tone: "warn" | "muted";
  spin?: boolean;
  delayed?: boolean;
} | null {
  switch (status.kind) {
    case "up":
      return null;
    case "connecting":
      // The first attach usually lands in well under a second; the delayed fade keeps a healthy
      // connect from flashing a card while an actually-slow dial stops looking like a wedged pane.
      return status.retrying
        ? { title: "Reconnecting…", tone: "warn", spin: true }
        : { title: "Connecting…", tone: "muted", spin: true, delayed: true };
    case "down":
      return {
        title: "Connection lost — retrying…",
        reason: status.reason,
        action: "Reconnect now",
        tone: "warn",
        spin: true,
      };
    case "ended":
      return { title: `Shell ended (${status.reason})`, tone: "muted" };
    case "failed": {
      // A protocol skew is not a fault to retry into — name the older side and
      // the fix; the pane recovers only after one end is upgraded.
      const skew = skewOf(status.reason);
      if (skew) {
        const card = skewCard(skew);
        return { title: card.title, reason: card.detail, tone: "warn" };
      }
      return {
        title: "Terminal failed",
        reason: status.reason,
        action: "Retry",
        tone: "warn",
      };
    }
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
