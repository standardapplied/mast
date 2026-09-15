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
 * something visible changed — rows, cursor. An idle terminal — no bytes since the last frame —
 * never touches the core: the cursor it read with the last damage is reused, so a frame costs a
 * comparison; the caller decides how often to call it (an animation frame is fine).
 */

import { keyEventFor, type KeyStroke, MODS } from "./input";
import { type LatencyStats, LatencyWindow } from "./latency";
import {
  type CellPos,
  type ColorScheme,
  type Cursor,
  type GridSnapshot,
  KITTY_KEY,
  type LinkRun,
  type RowSpan,
  type MatchSpan,
  type MouseEventSpec,
  type Rgb,
  type Scroll,
  type Scrollbar,
  type SearchState,
  type SurfacePos,
  type Theme,
  type VtCore,
} from "./vtCore";

/** The colors a renderer paints with that the core does not resolve per cell. */
export interface RendererColors {
  readonly bg: Rgb;
  readonly fg: Rgb;
  readonly cursor: Rgb;
  readonly selectionBg: Rgb;
  readonly selectionFg: Rgb;
}

/** What the controller needs from a renderer; the WebGPU renderer implements this structurally. */
export interface Renderer {
  resize(cols: number, rows: number): void;
  apply(snapshot: GridSnapshot): void;
  setCursor(cursor: Cursor): void;
  /** The link under the pointer, underlined whole; null when none. */
  setHover(run: LinkRun | null): void;
  /** The search matches on screen other than the selected one, to tint; empty when not searching. */
  setSearchMatches(spans: readonly MatchSpan[]): void;
  setColors(colors: RendererColors): void;
  draw(): void;
}

/** The outbound half of the pty: keystrokes and geometry headed to the session. */
export interface PtySink {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
}

/** The timers a resize settles on; injected so the trailing-edge behavior is testable without waiting. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ControllerOptions {
  /** Monotonic milliseconds; injected so the synchronized-output cap is testable. */
  readonly now?: () => number;
  readonly timers?: Timers;
}

/**
 * How long the geometry must hold before the pty hears it. A splitter drag resizes the pane every
 * layout tick; the local reflow follows each tick, but the host — which forces a `Resized` at every
 * other subscriber per SIGWINCH — hears only where the drag settled.
 */
export const RESIZE_SETTLE_MS = 60;

/**
 * How long a frame may be held under synchronized output (mode 2026). An app that begins a
 * synchronized update and dies, or forgets to end it, must not freeze the terminal forever.
 */
export const SYNCHRONIZED_OUTPUT_CAP_MS = 1000;

/**
 * How much of one frame the search may spend ticking through scrollback. The rest waits for the
 * next frame, so an hour of output is searched across frames and never stalls one.
 */
export const SEARCH_TICK_BUDGET_MS = 4;

/**
 * How long a sent key waits for its echo before it stops counting. A program that swallows a key
 * (a TUI in a non-echoing state) never answers it; the next unrelated output must not be read as
 * a very slow echo of that key forever.
 */
export const KEY_ECHO_TIMEOUT_MS = 2000;

export class TerminalController {
  private cols: number;
  private rows: number;
  /** Terminal state may have changed since the last frame: read the dirty rows. */
  private dirty = true;
  /** Something visible changed that the grid does not carry (selection, geometry): draw. */
  private redraw = true;
  /** The core's cursor as of the last dirty read; only bytes (or a scroll, a resize) can move it. */
  private rawCursor: Cursor | null = null;
  private lastCursor: Cursor | null = null;
  /** Where the pointer rests, for the link under it; null once it left the surface. */
  private hoverCell: CellPos | null = null;
  private hoverRun: LinkRun | null = null;
  private lastMotionCell = -1;
  private scrollbar: Scrollbar | null = null;
  /** The needle being searched for; empty when the search is idle. */
  private needle = "";
  /** The terminal moved under the search (a selected match, a fresh needle): feed before reading. */
  private searchStale = false;
  /** The first results of a fresh needle select the newest match, once. */
  private autoSelect = false;
  private searchStatus: SearchState["status"] = "complete";
  private lastSearch: SearchState | null = null;
  private spans: readonly MatchSpan[] = [];
  private unseenOutput = false;
  private syncSince: number | null = null;
  private replaying = false;
  private readonly now: () => number;
  private readonly timers: Timers;
  private pendingResize: unknown = null;
  /** Sent presses still waiting for their echo, oldest first: keydown time and arrival order. */
  private sentKeys: { at: number; order: number }[] = [];
  /** Arrival order of output chunks that came while keys were waiting, since the last paint. */
  private echoes: number[] = [];
  /** One sequence over keys and chunks: an echo can only follow the key it answers. */
  private order = 0;
  /** The frame in progress painted something; the echoes settle once it has drawn. */
  private painted = false;
  private readonly latency = new LatencyWindow();

  /** Side-channel intents found in the stream; the host wires these to the platform. */
  readonly hooks: {
    /** Returning false refuses the write; the program hears DENIED where the protocol replies. */
    onClipboard?: (text: string) => boolean | void;
    onTitle?: (title: string) => void;
    onBell?: () => void;
    /** The link under the resting pointer changed underneath it (output moved the screen). */
    onHover?: (run: LinkRun | null) => void;
    /** The viewport's place in scrollback changed (a scroll, output, a resize); once per change. */
    onScrollbar?: (bar: Scrollbar) => void;
    /** The search's counts or status changed; null once the search is cleared. */
    onSearch?: (state: SearchState | null) => void;
    /** A typed key's echo painted: the rolling keystroke latency over the last hundred keys. */
    onLatency?: (stats: LatencyStats) => void;
  } = {};

  constructor(
    private readonly core: VtCore,
    private renderer: Renderer,
    private readonly sink: PtySink,
    options: ControllerOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.timers = options.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const size = core.size;
    this.cols = size.cols;
    this.rows = size.rows;
    this.renderer.resize(this.cols, this.rows);
    // The core's effects fire synchronously inside feed(). A replayed query, OSC 52 or bell is
    // history: answering a stale query, clobbering the clipboard the user filled since, or ringing
    // for output long gone would be wrong. A replayed title is current state and always applies.
    core.hooks.onWritePty = (reply) => {
      if (!this.replaying) this.sink.write(reply);
    };
    core.hooks.onClipboard = (text) => (this.replaying ? false : this.hooks.onClipboard?.(text));
    core.hooks.onTitle = (title) => this.hooks.onTitle?.(title);
    core.hooks.onBell = () => {
      if (!this.replaying) this.hooks.onBell?.();
    };
  }

  /**
   * Feeds pty output bytes into terminal state; a later {@link #frame} paints the result. Any
   * reply the stream provokes (a query the program made) leaves for the pty from inside this call.
   */
  feed(bytes: Uint8Array): void {
    if (bytes.length > 0) {
      this.core.write(bytes);
      this.dirty = true;
      if (!this.replaying && this.echoes.length < this.sentKeys.length) this.echoes.push(++this.order);
      if (!this.core.viewportActive()) {
        this.unseenOutput = true;
      }
    }
  }

  /** The keystroke latency over the last hundred echoed keys; null before the first. */
  keystrokeLatency(): LatencyStats | null {
    return this.latency.stats();
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
    this.dirty = true;
    this.sentKeys = [];
    this.echoes = [];
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
    this.pumpSearch();
    if (this.dirty) {
      if (this.holdForSynchronizedOutput()) {
        return;
      }
      const snapshot = this.core.snapshot();
      if (snapshot.dirty !== "none") {
        this.renderer.apply(snapshot);
        this.redraw = true;
        if (this.hoverCell && this.resolveHover(this.hoverCell)) {
          this.hooks.onHover?.(this.hoverRun);
        }
      }
      this.painted = snapshot.dirty !== "none";
      if (!this.painted) this.echoes = [];
      this.core.clean();
      this.rawCursor = this.core.cursor();
      this.dirty = false;
      this.pollScrollbar();
    }
    const cursor = this.rawCursor!;
    const shown = cursor.visible && (!focused || !cursor.blinking || blinkOn);
    const next: Cursor = { ...cursor, visible: shown, style: focused ? cursor.style : "hollow" };
    if (!this.redraw && this.lastCursor !== null && sameCursor(this.lastCursor, next)) {
      return;
    }
    this.lastCursor = next;
    this.redraw = false;
    this.renderer.setCursor(next);
    this.renderer.draw();
    if (this.painted) {
      this.painted = false;
      this.settleEchoes();
    }
  }

  /**
   * Searches the terminal — active area and scrollback — for {@code needle}; empty ends the search
   * and drops its highlights. The search runs across frames (see {@link pumpSearch}) and reports
   * on {@link hooks.onSearch}; the first results select the newest match. Resubmitting the same
   * needle keeps the results, so a find bar can call this on every keystroke.
   */
  search(needle: string): void {
    if (needle === this.needle) return;
    this.needle = needle;
    this.core.setSearchNeedle(needle);
    this.clearSelection();
    if (needle.length === 0) {
      this.searchStatus = "complete";
      this.setSpans([]);
      this.reportSearch(null);
      return;
    }
    this.searchStatus = "feed-required";
    this.searchStale = true;
    this.autoSelect = true;
  }

  /**
   * Selects the next match (older, up into history, wrapping) or the previous one (newer) and
   * paints it as the selection; the viewport scrolls to it when it is off-screen. False when there
   * is no match to move to.
   */
  searchStep(direction: "next" | "prev"): boolean {
    if (this.needle.length === 0 || !this.core.searchSelect(direction)) return false;
    this.autoSelect = false;
    this.searchStale = true;
    this.dirty = true;
    return true;
  }

  /**
   * Drives the search one bounded step per frame: a feed whenever the terminal changed since the
   * last one (bytes, a scroll, a resize, a selected match) or the search is still working, then
   * ticks until it is caught up or the frame's budget is spent. The viewport's matches are read
   * back after every feed, never kept across writes, since a write invalidates every match.
   */
  private pumpSearch(): void {
    if (this.needle.length === 0) return;
    const changed = this.dirty || this.searchStale;
    if (changed || this.searchStatus !== "complete") {
      this.core.searchFeed();
      this.searchStale = false;
      this.searchStatus = this.core.searchState().status;
      if (this.searchStatus !== "complete") {
        const deadline = this.now() + SEARCH_TICK_BUDGET_MS;
        do {
          this.searchStatus = this.core.searchTick();
          if (this.searchStatus === "feed-required") this.core.searchFeed();
        } while (this.searchStatus !== "complete" && this.now() < deadline);
        // The viewport's list is built by feeds: the matches the last ticks found need one more.
        if (this.searchStatus === "complete") this.core.searchFeed();
      }
      this.setSpans(this.core.searchViewportMatches());
    }
    const state = this.core.searchState();
    if (this.autoSelect && state.total > 0 && this.core.searchSelect("next")) {
      this.autoSelect = false;
      this.searchStale = true;
      this.dirty = true;
      this.reportSearch(this.core.searchState());
      return;
    }
    this.reportSearch(state);
  }

  private setSpans(next: readonly MatchSpan[]): void {
    if (sameSpans(this.spans, next)) return;
    this.spans = next;
    this.renderer.setSearchMatches(next);
    this.redraw = true;
  }

  private reportSearch(state: SearchState | null): void {
    if (sameSearch(this.lastSearch, state)) return;
    this.lastSearch = state;
    this.hooks.onSearch?.(state);
  }

  /** The core keeps no change notification for scroll position: read it per dirty frame and diff. */
  private pollScrollbar(): void {
    const next = this.core.scrollbar();
    const last = this.scrollbar;
    if (last && last.total === next.total && last.offset === next.offset && last.len === next.len) {
      return;
    }
    this.scrollbar = next;
    this.hooks.onScrollbar?.(next);
  }

  /**
   * Times the keys whose echo the frame just drew. Output cannot be attributed to a key by content
   * — a shell echoes one byte, a TUI redraws a screen — so each chunk that arrived while keys
   * were waiting is taken as the echo of the oldest key pressed before it; a chunk that predates
   * a key can never be that key's echo. Only chunks that changed pixels reach here, and the clock
   * is read after the draw, so the number is keydown to pixels. Keys older than
   * {@link KEY_ECHO_TIMEOUT_MS} were swallowed and drop uncounted.
   */
  private settleEchoes(): void {
    const now = this.now();
    while (this.sentKeys.length > 0 && now - this.sentKeys[0]!.at > KEY_ECHO_TIMEOUT_MS) {
      this.sentKeys.shift();
    }
    let stats: LatencyStats | null = null;
    for (const arrived of this.echoes) {
      const key = this.sentKeys[0];
      if (key === undefined) break;
      if (arrived < key.order) continue;
      this.sentKeys.shift();
      stats = this.latency.push(now - key.at);
    }
    this.echoes = [];
    if (stats !== null) this.hooks.onLatency?.(stats);
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
   * key. No local echo — the pty echoes. Cmd chords belong to the app and the OS — the pane
   * routes the ones it owns (copy, paste, clear) before calling here — unless the program asked
   * for every key (kitty report-all), which is how a TUI hears ⌘ chords at all. Releases reach
   * the pty only when the program asked for release events; legacy programs never hear them. The
   * ⌘ gate is for presses: the pane reports a release only for a press the program heard, and a
   * ⌘ that went down during the hold is a modifier on that release, not a chord. {@code at} is
   * the keydown's own timestamp, on the {@link ControllerOptions#now} clock, so the latency the
   * pane shows starts at the key and not at the handler.
   */
  key(stroke: KeyStroke, at = this.now()): boolean {
    const flags = this.core.kittyKeyboardFlags();
    if (stroke.release) {
      if ((flags & KITTY_KEY.REPORT_EVENTS) === 0) return false;
    } else if (stroke.meta && (flags & KITTY_KEY.REPORT_ALL) === 0) {
      return false;
    }
    const bytes = this.core.encodeKey(keyEventFor(stroke));
    if (bytes === null) {
      return false;
    }
    this.sink.write(bytes);
    if (!stroke.release) this.sentKeys.push({ at, order: ++this.order });
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

  /** Moves the viewport one screen through scrollback ({@code -1} = up, towards history). */
  scrollPage(direction: -1 | 1): void {
    this.scroll({ delta: direction * this.rows });
  }

  /**
   * Ghostty's ⌘K: scrollback gone, the screen above the prompt blanked, the viewport live again.
   * When prompt marks let the core erase everything, the shell is asked to repaint its prompt.
   */
  clearScreen(): void {
    this.scroll("bottom");
    const repaint = this.core.clearScreen();
    if (repaint !== null) {
      this.sink.write(repaint);
    }
  }

  /**
   * Applies a new theme to the live terminal: the core's defaults and palette, the renderer's
   * own colors, then a full repaint so every default-colored cell re-resolves. The session is
   * untouched. A program under mode 2031 hears that the scheme flipped.
   */
  setTheme(theme: Theme & RendererColors, scheme: ColorScheme): void {
    this.core.setTheme(theme, scheme);
    this.renderer.setColors(theme);
    this.renderer.apply(this.core.readAll());
    this.rawCursor = this.core.cursor();
    this.redraw = true;
    if (this.core.colorSchemeReporting()) {
      this.sink.write(this.core.encodeColorSchemeReport());
    }
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
   * their own dialect — unless it turned alternate scroll (mode 1007) off, in which case the
   * wheel means nothing there.
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
    if (!this.core.alternateScroll()) {
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

  /**
   * Selection is the terminal's own (libghostty tracks it through scrolling and output), so these
   * only route the pointer and mark a repaint: press starts a gesture (a repeat click widens it to
   * the word, then the line), drag extends it, release closes it. Positions are surface pixels in
   * the same unit as the cell size the renderer reported.
   */
  selectPress(cell: CellPos, px: SurfacePos, timeMs: number): void {
    this.core.selectionPress(cell, px, timeMs);
    this.dirty = true;
  }

  selectDrag(cell: CellPos, px: SurfacePos): void {
    this.core.selectionDrag(cell, px);
    this.dirty = true;
  }

  selectRelease(cell: CellPos | null): void {
    this.core.selectionRelease(cell);
  }

  /** Drops the selection; the next frame repaints without it. */
  clearSelection(): void {
    if (this.core.hasSelection()) {
      this.core.clearSelection();
      this.dirty = true;
    }
  }

  /** The selected text (across scrollback, wrapped rows unwrapped); empty when nothing is selected. */
  selectedText(): string {
    return this.core.selectionText();
  }

  /**
   * Resizes the terminal to {@code cols}×{@code rows}: VtCore reflows and the renderer resizes its
   * surface at once; the pty learns the geometry (SIGWINCH) once it has held for
   * {@link RESIZE_SETTLE_MS}. {@code silent} adopts a size the pty already has — another writer
   * resized it — so nothing is announced back. A no-op when the size is unchanged, so a stream of
   * identical resize events costs nothing.
   */
  resize(cols: number, rows: number, opts: { silent?: boolean } = {}): void {
    this.cancelPendingResize();
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.core.resize(cols, rows);
    this.renderer.resize(cols, rows);
    this.dirty = true;
    this.redraw = true;
    if (!opts.silent) {
      this.pendingResize = this.timers.set(() => {
        this.pendingResize = null;
        this.sink.resize(cols, rows);
      }, RESIZE_SETTLE_MS);
    }
  }

  private cancelPendingResize(): void {
    if (this.pendingResize !== null) {
      this.timers.clear(this.pendingResize);
      this.pendingResize = null;
    }
  }

  /**
   * The pointer rests on {@code cell} (null: it left the surface): the link there, if any, is
   * underlined whole until the pointer moves on. The run follows the screen — output that scrolls
   * the link away, or under the pointer, re-resolves it on the next frame ({@link hooks.onHover}).
   */
  hover(cell: CellPos | null): LinkRun | null {
    this.hoverCell = cell;
    this.resolveHover(cell);
    return this.hoverRun;
  }

  /** The link under a cell, with no side effects (the ⌘-click target). */
  linkAt(cell: CellPos): LinkRun | null {
    return this.core.linkAt(cell);
  }

  /** Re-reads the link under {@code cell} into the renderer; true when it changed. */
  private resolveHover(cell: CellPos | null): boolean {
    const next = cell ? this.core.linkAt(cell) : null;
    if (sameRun(this.hoverRun, next)) {
      return false;
    }
    this.hoverRun = next;
    this.renderer.setHover(next);
    this.redraw = true;
    return true;
  }

  /**
   * Swaps in a fresh renderer (the GPU device or GL context was lost and rebuilt) and repaints it
   * whole from the core: the terminal state never left, only the pixels did.
   */
  replaceRenderer(renderer: Renderer): void {
    this.renderer = renderer;
    renderer.resize(this.cols, this.rows);
    renderer.apply(this.core.readAll());
    renderer.setHover(this.hoverRun);
    renderer.setSearchMatches(this.spans);
    this.lastCursor = null;
    this.redraw = true;
  }

  /** Drops a pending pty resize; the pane is going away and the sink with it. */
  dispose(): void {
    this.cancelPendingResize();
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
}

function sameRun(a: LinkRun | null, b: LinkRun | null): boolean {
  if (a === null || b === null) return a === b;
  return a.uri === b.uri && sameSpans(a.spans, b.spans);
}

function sameSpans(a: readonly RowSpan[], b: readonly RowSpan[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.y === b[i]!.y && s.start === b[i]!.start && s.end === b[i]!.end)
  );
}

function sameSearch(a: SearchState | null, b: SearchState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status && a.total === b.total && a.selected === b.selected;
}

function sameCursor(a: Cursor, b: Cursor): boolean {
  return (
    a.present === b.present &&
    a.visible === b.visible &&
    a.x === b.x &&
    a.y === b.y &&
    a.style === b.style &&
    sameColor(a.color, b.color)
  );
}

function sameColor(a: Rgb | null, b: Rgb | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
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
