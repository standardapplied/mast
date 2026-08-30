/**
 * TerminalController — the widget's brain, with no pixels and no transport of its own.
 *
 * It drives three collaborators through narrow seams: a {@link VtCore} for terminal state, a {@link
 * Renderer} for drawing, and a {@link PtySink} for bytes headed back to the pty. Because the
 * renderer and the sink are interfaces, the whole controller runs under `bun test` against the real
 * VtCore with a recording renderer and sink — no WebGPU, no Tauri, no DOM. The React component and
 * the WebGPU renderer are the thin, untested edge that wires these seams to the live app.
 *
 * Damage-aware: {@link #frame} applies only the rows VtCore reports dirty, then draws. Idle frames
 * cost one snapshot and one draw; the caller decides how often to call it (new data, resize, cursor
 * blink), so nothing spins when the screen is quiet.
 */

import { keyEventFor, type KeyStroke } from "./input";
import { Osc52Scanner } from "./osc52";
import { type Selection, selectedText } from "./selection";
import type { Cursor, GridSnapshot, Scroll, VtCore } from "./vtCore";

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

export class TerminalController {
  private cols: number;
  private rows: number;
  private dirty = false;
  private selection: Selection | null = null;
  private readonly osc52 = new Osc52Scanner();
  private replaying = false;

  /** Side-channel intents found in the stream; the host wires these to the platform. */
  readonly hooks: { onClipboard?: (text: string) => void } = {};

  constructor(
    private readonly core: VtCore,
    private readonly renderer: Renderer,
    private readonly sink: PtySink,
  ) {
    const size = core.size;
    this.cols = size.cols;
    this.rows = size.rows;
    this.renderer.resize(this.cols, this.rows);
  }

  /** Feeds pty output bytes into terminal state; a later {@link #frame} paints the result. */
  feed(bytes: Uint8Array): void {
    if (bytes.length > 0) {
      for (const text of this.osc52.feed(bytes)) {
        // A replayed OSC 52 is history, not a user action — honoring it would clobber whatever
        // the user copied since. The scanner still runs so its state tracks the byte stream.
        if (!this.replaying) {
          this.hooks.onClipboard?.(text);
        }
      }
      this.core.write(bytes);
      this.dirty = true;
    }
  }

  /**
   * Wipes the terminal to a blank ground state ahead of a journal replay. A mid-stream replay
   * means the host dropped part of the stream (flow-control pause) and is re-baselining us — the
   * snapshot must land on a clean terminal (and a clean scanner), not on top of the gap's
   * leftovers. Clipboard side effects stay off until {@link endReplay}.
   */
  resetForReplay(): void {
    this.core.reset();
    this.osc52.reset();
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
   * Renders one frame: when bytes have arrived since the last paint, re-reads the whole viewport and
   * applies it, then draws with the cursor. {@code blinkOn} folds the UI blink phase into the pty's
   * own cursor visibility.
   *
   * <p>The repaint is gated on our own "bytes fed" flag, not libghostty-vt's damage: it only flags a
   * scroll as dirty, never an in-place edit (readline echoing a keystroke, a one-line command's
   * output), so a renderer that trusts its dirty gate silently drops them and typed text stays
   * invisible. We know when data arrived, so we re-read every row then and nothing is missed; idle
   * frames still cost only a cursor draw.
   */
  frame(blinkOn = true): void {
    if (this.dirty) {
      this.renderer.apply(this.core.readAll());
      this.core.clean();
      this.dirty = false;
    }
    const cursor = this.core.cursor();
    this.renderer.setCursor({ ...cursor, visible: cursor.visible && blinkOn });
    this.renderer.draw();
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
   * Routes mouse-wheel intent ({@code lines} < 0 = up): the local scrollback normally, but an
   * alternate-screen TUI (vim, less, claude-code) has no scrollback — it gets arrow keys, one per
   * line, encoded mode-aware so DECCKM applications hear their own dialect.
   */
  wheel(lines: number): void {
    if (lines === 0) {
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
    this.dirty = true;
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
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
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
