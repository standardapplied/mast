/**
 * TerminalController — the widget's brain, with no pixels and no transport of its own.
 *
 * It drives three collaborators through narrow seams: a {@link VtCore} for terminal state, a {@link
 * Renderer} for drawing, and a {@link PtySink} for bytes headed back to the pty. Because the
 * renderer and the sink are interfaces, the whole controller runs under `bun test` against the real
 * VtCore with a recording renderer and sink — no WebGPU, no Tauri, no DOM. The React component and
 * the WebGPU renderer are the thin, untested edge that wires these seams to the live app.
 *
 * Damage-driven: {@link #frame} applies only the rows VtCore reports dirty, then draws only when
 * something visible changed — rows, cursor, selection. An idle terminal costs one mode query per
 * frame and nothing else; the caller decides how often to call it (an animation frame is fine).
 */

import { keyEventFor, type KeyStroke, MODS } from "./input";
import { type Selection, selectedText } from "./selection";
import type { Cursor, GridSnapshot, MouseEventSpec, Scroll, VtCore } from "./vtCore";

/** What the controller needs from a renderer; the WebGPU renderer implements this structurally. */
export interface Renderer {
  resize(cols: number, rows: number): void;
  apply(snapshot: GridSnapshot): void;
  setCursor(cursor: Cursor): void;
  setSelection(selection: Selection | null): void;
  draw(): void;
}

/** The outbound half of the pty: keystrokes and geometry headed to the session. */
export interface PtySink {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
}

export interface ControllerOptions {
  /** Monotonic milliseconds; injected so the synchronized-output cap is testable. */
  readonly now?: () => number;
}

/**
 * How long a frame may be held under synchronized output (mode 2026). An app that begins a
 * synchronized update and dies, or forgets to end it, must not freeze the terminal forever.
 */
export const SYNCHRONIZED_OUTPUT_CAP_MS = 1000;

export class TerminalController {
  private cols: number;
  private rows: number;
  /** Terminal state may have changed since the last frame: read the dirty rows. */
  private dirty = true;
  /** Something visible changed that the grid does not carry (selection, geometry): draw. */
  private redraw = true;
  private lastCursor: Cursor | null = null;
  private lastMotionCell = -1;
  private unseenOutput = false;
  private syncSince: number | null = null;
  private selection: Selection | null = null;
  private replaying = false;
  private readonly now: () => number;

  /** Side-channel intents found in the stream; the host wires these to the platform. */
  readonly hooks: {
    onClipboard?: (text: string) => void;
    onTitle?: (title: string) => void;
    onBell?: () => void;
  } = {};

  constructor(
    private readonly core: VtCore,
    private readonly renderer: Renderer,
    private readonly sink: PtySink,
    options: ControllerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    const size = core.size;
    this.cols = size.cols;
    this.rows = size.rows;
    this.renderer.resize(this.cols, this.rows);
    // The core's effects fire synchronously inside feed(). A replayed query or OSC 52 is history:
    // answering a stale query or clobbering the clipboard the user filled since would be wrong. A
    // replayed title is current state and always applies.
    core.hooks.onWritePty = (reply) => {
      if (!this.replaying) this.sink.write(reply);
    };
    core.hooks.onClipboard = (text) => {
      if (!this.replaying) this.hooks.onClipboard?.(text);
    };
    core.hooks.onTitle = (title) => this.hooks.onTitle?.(title);
    core.hooks.onBell = () => this.hooks.onBell?.();
  }

  /**
   * Feeds pty output bytes into terminal state; a later {@link #frame} paints the result. Any
   * reply the stream provokes (a query the program made) leaves for the pty from inside this call.
   */
  feed(bytes: Uint8Array): void {
    if (bytes.length > 0) {
      this.core.write(bytes);
      this.dirty = true;
      if (!this.core.viewportActive()) {
        this.unseenOutput = true;
      }
    }
  }

  /**
   * Whether output arrived below the viewport while the user was scrolled into history. The
   * viewport deliberately stays put when that happens (as in Ghostty), so the host offers a way
   * back down; this turns false the moment the viewport is live again.
   */
  hasUnseenOutput(): boolean {
    if (this.unseenOutput && this.core.viewportActive()) {
      this.unseenOutput = false;
    }
    return this.unseenOutput;
  }

  /**
   * Wipes the terminal to a blank ground state ahead of a journal replay. A mid-stream replay
   * means the host dropped part of the stream (flow-control pause) and is re-baselining us — the
   * snapshot must land on a clean terminal, not on top of the gap's leftovers. Clipboard writes
   * and query replies stay off until {@link endReplay}.
   */
  resetForReplay(): void {
    this.core.reset();
    this.replaying = true;
    this.setSelection(null);
    this.dirty = true;
  }

  /** The replay bracket closed: bytes are live again, side effects re-arm. */
  endReplay(): void {
    this.replaying = false;
  }

  /** Reports a focus change to the application — only when it asked (mode 1004). */
  setFocus(focused: boolean): void {
    if (this.core.focusReporting()) {
      this.sink.write(this.core.encodeFocus(focused));
    }
  }

  /**
   * Renders one frame if anything visible changed: applies the rows VtCore reports dirty, folds
   * the cursor in, and draws. {@code blinkOn} is the UI blink phase; it applies only when the
   * terminal asked for a blinking cursor. An unfocused terminal shows a steady hollow cursor, as
   * native terminals do, whatever shape the application chose.
   *
   * <p>Under synchronized output (mode 2026) the frame is held so a TUI's multi-write redraw
   * lands at once instead of tearing — up to {@link SYNCHRONIZED_OUTPUT_CAP_MS}, after which the
   * hold is released regardless.
   */
  frame(blinkOn = true, focused = true): void {
    if (this.holdForSynchronizedOutput()) {
      return;
    }
    if (this.dirty) {
      const snapshot = this.core.snapshot();
      if (snapshot.dirty !== "none") {
        this.renderer.apply(snapshot);
        this.redraw = true;
      }
      this.core.clean();
      this.dirty = false;
    }
    const cursor = this.core.cursor();
    const shown = cursor.visible && (!focused || !cursor.blinking || blinkOn);
    const next: Cursor = { ...cursor, visible: shown, style: focused ? cursor.style : "hollow" };
    if (!this.redraw && this.lastCursor !== null && sameCursor(this.lastCursor, next)) {
      return;
    }
    this.lastCursor = next;
    this.redraw = false;
    this.renderer.setCursor(next);
    this.renderer.draw();
  }

  private holdForSynchronizedOutput(): boolean {
    if (!this.core.synchronizedOutput()) {
      this.syncSince = null;
      return false;
    }
    const now = this.now();
    this.syncSince ??= now;
    return now - this.syncSince < SYNCHRONIZED_OUTPUT_CAP_MS;
  }

  /**
   * Encodes a key press through libghostty's mode-aware key encoder (DECCKM, kitty protocol,
   * modifyOtherKeys — see {@link VtCore#encodeKey}) and sends it to the pty. Returns whether
   * anything was sent, so the caller can preventDefault exactly when the terminal consumed the
   * key. No local echo — the pty echoes. Cmd chords never reach the pty: they belong to the app
   * and the OS, and the pane routes the ones it owns (copy, paste, splits) before calling here.
   */
  key(stroke: KeyStroke): boolean {
    if (stroke.meta) {
      return false;
    }
    const bytes = this.core.encodeKey(keyEventFor(stroke));
    if (bytes === null) {
      return false;
    }
    this.sink.write(bytes);
    return true;
  }

  /**
   * Sends committed composition text (an IME commit, a dead-key sequence like Option+E then E) to
   * the pty as-is. The composing keydowns themselves encode nothing — this is their delivery path.
   */
  text(committed: string): void {
    if (committed.length > 0) {
      this.sink.write(new TextEncoder().encode(committed));
    }
  }

  /**
   * Sends pasted text to the pty, encoded for the terminal's paste state (bracketed-paste framing
   * when the app enabled mode 2004, newline→CR conversion when it didn't; ESC bytes stripped either
   * way — see {@link VtCore#encodePaste}). Returns false — writing nothing — when the paste needs
   * the user's confirmation first: multi-line text into an unbracketed terminal runs each line as a
   * command the moment it lands. Confirm and call again with {@code force}.
   */
  paste(text: string, opts: { force?: boolean } = {}): boolean {
    if (text.length === 0) {
      return true;
    }
    // A newline with more content behind it is the dangerous shape; the trailing newline on a
    // single copied command is routine and pastes straight through.
    if (!opts.force && !this.core.bracketedPaste() && /[\r\n]\s*\S/.test(text)) {
      return false;
    }
    this.sink.write(this.core.encodePaste(text));
    return true;
  }

  /** Moves the viewport through scrollback; the next {@link #frame} repaints at the new position. */
  scroll(behavior: Scroll): void {
    this.core.scroll(behavior);
    this.dirty = true;
  }

  /**
   * Offers a mouse event to the application. Consumed (true) when the application tracks the
   * mouse — the event is encoded in its requested format and sent, or deduplicated away — so the
   * caller must not treat it as a local gesture. Not consumed (false) when no tracking mode is on,
   * or when Shift is held: Shift is the user's way past the application to local selection and
   * scrolling, as in every native terminal.
   */
  mouse(spec: MouseEventSpec): boolean {
    if ((spec.mods & MODS.SHIFT) !== 0 || !this.core.mouseTracking()) {
      return false;
    }
    // Pointer motion arrives per pixel; the application hears one report per cell.
    if (spec.action === "motion") {
      const cell = spec.y * this.cols + spec.x;
      if (cell === this.lastMotionCell) return true;
      this.lastMotionCell = cell;
    } else {
      this.lastMotionCell = -1;
    }
    const bytes = this.core.encodeMouse(spec);
    if (bytes !== null) {
      this.sink.write(bytes);
    }
    return true;
  }

  /**
   * Routes mouse-wheel intent ({@code lines} < 0 = up). An application tracking the mouse hears
   * wheel buttons at the cell under the pointer (unless Shift bypasses it); otherwise the local
   * scrollback scrolls — except on the alternate screen, which has no scrollback: a full-screen
   * TUI (vim, less) gets arrow keys, one per line, encoded mode-aware so DECCKM applications hear
   * their own dialect.
   */
  wheel(lines: number, at?: { x: number; y: number }, mods = 0): void {
    if (lines === 0) {
      return;
    }
    if (at && (mods & MODS.SHIFT) === 0 && this.core.mouseTracking()) {
      const button = lines < 0 ? "wheelUp" : "wheelDown";
      for (let i = 0; i < Math.abs(lines); i++) {
        this.mouse({ action: "press", button, mods, x: at.x, y: at.y });
      }
      return;
    }
    if (!this.core.altScreen()) {
      this.scroll({ delta: lines });
      return;
    }
    const key = lines < 0 ? "ArrowUp" : "ArrowDown";
    const stroke = keyEventFor({ key, code: key });
    const bytes = this.core.encodeKey(stroke);
    if (bytes === null) {
      return;
    }
    const out = new Uint8Array(bytes.length * Math.abs(lines));
    for (let i = 0; i < Math.abs(lines); i++) {
      out.set(bytes, i * bytes.length);
    }
    this.sink.write(out);
  }

  /** Sets (or clears) the highlighted selection; the next frame repaints it. */
  setSelection(selection: Selection | null): void {
    this.selection = selection;
    this.renderer.setSelection(selection);
    this.redraw = true;
  }

  /** The selected text, newline-joined and per-line right-trimmed; empty when nothing is selected. */
  selectedText(): string {
    if (!this.selection || this.selection.isEmpty) return "";
    const rows = this.core.readAll().rows.map((r) => r.cells.map((c) => c.text));
    return selectedText(this.selection, rows);
  }

  /**
   * Resizes the terminal to {@code cols}×{@code rows}: VtCore reflows, the renderer resizes its
   * surface, and the pty learns the new geometry (SIGWINCH). A no-op when the size is unchanged, so
   * a stream of identical resize events costs nothing.
   */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.core.resize(cols, rows);
    this.renderer.resize(cols, rows);
    this.sink.resize(cols, rows);
    this.dirty = true;
    this.redraw = true;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
}

function sameCursor(a: Cursor, b: Cursor): boolean {
  return (
    a.present === b.present &&
    a.visible === b.visible &&
    a.x === b.x &&
    a.y === b.y &&
    a.style === b.style
  );
}

/**
 * The largest {@code cols}×{@code rows} grid that fits {@code pxW}×{@code pxH} device pixels at the
 * given cell size, clamped to a sane floor so a collapsed container never asks for a 0×0 terminal.
 */
export function gridFor(
  pxW: number,
  pxH: number,
  cellW: number,
  cellH: number,
): { cols: number; rows: number } {
  const cols = Math.max(1, Math.floor(pxW / cellW));
  const rows = Math.max(1, Math.floor(pxH / cellH));
  return { cols, rows };
}
