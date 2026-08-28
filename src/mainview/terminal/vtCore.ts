/**
 * VtCore — a thin, stable wrapper over the official libghostty-vt WebAssembly (see PIN.md).
 *
 * We feed it raw PTY bytes and read the resulting terminal grid to render ourselves. libghostty-vt
 * owns the hard part — the VT parser, the grid, scrollback, reflow, and damage tracking; VtCore
 * owns none of that logic, only the binding. The renderer consumes {@link GridSnapshot}; it never
 * touches the wasm, so the rendering backend (WebGPU/WebGL2) and the VT core evolve independently.
 *
 * The upstream C ABI is a public alpha with no tagged release, so every raw call is confined to the
 * private {@link Abi} helper below — churn is isolated to this one file, behind a stable surface.
 */

/** A resolved 8-bit RGB triple, already accounting for the palette. */
export type Rgb = readonly [number, number, number];

/** One rendered cell: text (a grapheme cluster), resolved colors, and SGR style. Colors already
 *  account for reverse video (fg/bg are swapped when the cell is inverse). */
export interface Cell {
  readonly text: string;
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly faint: boolean;
}

/** A cell with no styling, before colors are filled in — the common case (plain text). */
const PLAIN = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  faint: false,
  inverse: false,
} as const;

interface CellStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  faint: boolean;
  inverse: boolean;
}

/** A row of cells at viewport position {@link y}. */
export interface Row {
  readonly y: number;
  readonly cells: Cell[];
}

/** How much changed since the last {@link VtCore.clean}: nothing, some rows, or everything. */
export type Dirty = "none" | "partial" | "full";

/** The rows that changed since the last clean, ready to hand to the renderer. */
export interface GridSnapshot {
  readonly dirty: Dirty;
  readonly rows: Row[];
}

/** The cursor's viewport position and visibility; {@link present} is false when off-screen. */
export interface Cursor {
  readonly present: boolean;
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}

const SUCCESS = 0;

// Terminal dimensions are u16 inside libghostty-vt; reject anything that would
// truncate, so the cached size can never disagree with the real grid.
const MAX_DIM = 65535;

// Enum values from ghostty/vt/render.h (build 1.3.2 +d9840f3), pinned alongside the wasm.
const RS_DATA_DIRTY = 3;
const RS_DATA_ROW_ITERATOR = 4;
const RS_DATA_CURSOR_VISIBLE = 11;
const RS_DATA_CURSOR_VIEWPORT_HAS_VALUE = 14;
const RS_DATA_CURSOR_VIEWPORT_X = 15;
const RS_DATA_CURSOR_VIEWPORT_Y = 16;
const ROW_DATA_CELLS = 3;
const CELLS_DATA_STYLE = 2;
const CELLS_DATA_GRAPHEMES_LEN = 3;
const CELLS_DATA_GRAPHEMES_BUF = 4;
const CELLS_DATA_BG_COLOR = 5;
const CELLS_DATA_FG_COLOR = 6;
const CELLS_DATA_HAS_STYLING = 8;

// GhosttyStyle field byte offsets (wasm32) and struct size, confirmed against the wasm. The bool
// flags sit past three GhosttyStyleColor unions; `underline` is an int (>0 ⇒ underlined).
const STYLE_SIZE = 72;
const STYLE_BOLD = 56;
const STYLE_ITALIC = 57;
const STYLE_FAINT = 58;
const STYLE_INVERSE = 60;
const STYLE_STRIKETHROUGH = 62;
const STYLE_UNDERLINE = 64;
const DIRTY_FALSE = 0;
const DIRTY_PARTIAL = 1;

/**
 * The colors a {@link VtCore} runs with. `fg`/`bg`/`cursor` are the terminal's defaults; `palette`
 * is the 16 ANSI base colors that indexed SGR colors (`\x1b[31m`, `\x1b[38;5;Nm` 0-15) resolve
 * through. True-color (`\x1b[38;2;…m`) is unaffected — it carries its own RGB. Configured into
 * libghostty via {@code ghostty_terminal_set}; the base-color entries override the default 256
 * palette so indexed colors match the embedder's design instead of ghostty's stock palette.
 */
export interface Theme {
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly cursor: Rgb;
  readonly palette: readonly Rgb[];
}

/** A neutral dark fallback for callers (mainly tests) that do not supply a theme. */
const DEFAULT_THEME: Theme = {
  fg: [220, 224, 230],
  bg: [11, 14, 20],
  cursor: [252, 73, 38],
  palette: [
    [18, 23, 27],
    [224, 123, 111],
    [134, 184, 154],
    [210, 162, 76],
    [147, 179, 215],
    [208, 143, 166],
    [127, 191, 202],
    [201, 196, 188],
    [74, 85, 96],
    [240, 150, 138],
    [163, 209, 179],
    [230, 186, 105],
    [174, 200, 232],
    [227, 168, 188],
    [156, 212, 222],
    [246, 241, 233],
  ],
};

/** Terminal option ids for {@code ghostty_terminal_set} (from ghostty/vt/terminal.h). */
const OPT_COLOR_FOREGROUND = 11;
const OPT_COLOR_BACKGROUND = 12;
const OPT_COLOR_CURSOR = 13;
const OPT_COLOR_PALETTE = 14;

/** The subset of libghostty-vt exports VtCore drives. */
interface GhosttyExports {
  memory: WebAssembly.Memory;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_wasm_free_opaque(slot: number): void;
  ghostty_terminal_new(alloc: number, out: number, cols: number, rows: number): number;
  ghostty_terminal_set(term: number, option: number, value: number): number;
  ghostty_color_palette_default(palette: number): void;
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void;
  ghostty_terminal_resize(term: number, cols: number, rows: number, cw: number, ch: number): number;
  ghostty_terminal_free(term: number): void;
  ghostty_render_state_new(alloc: number, out: number): number;
  ghostty_render_state_update(state: number, term: number): number;
  ghostty_render_state_clean(state: number): void;
  ghostty_render_state_get(state: number, data: number, out: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_row_iterator_new(alloc: number, out: number): number;
  ghostty_render_state_row_iterator_next(it: number): boolean;
  ghostty_render_state_row_iterator_next_dirty(it: number, outY: number): boolean;
  ghostty_render_state_row_iterator_free(it: number): void;
  ghostty_render_state_row_get(it: number, data: number, out: number): number;
  ghostty_render_state_row_cells_new(alloc: number, out: number): number;
  ghostty_render_state_row_cells_next(cells: number): boolean;
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
}

/**
 * The low-level ABI seam: wasm memory, the allocator, and libghostty-vt's opaque-handle protocol.
 * Every memory view is re-acquired on access because a wasm call may grow linear memory and
 * invalidate prior views (the caveat stated in ghostty/vt/wasm.h). Nothing here knows terminal
 * semantics — that all lives in {@link VtCore}.
 */
class Abi {
  constructor(private readonly e: GhosttyExports) {}

  private u8(): Uint8Array {
    return new Uint8Array(this.e.memory.buffer);
  }

  private view(): DataView {
    return new DataView(this.e.memory.buffer);
  }

  alloc(len: number): number {
    const ptr = this.e.ghostty_wasm_alloc(len);
    if (ptr === 0 && len > 0) {
      throw new Error("libghostty-vt: out of wasm memory");
    }
    return ptr;
  }

  free(ptr: number, len: number): void {
    this.e.ghostty_wasm_free(ptr, len);
  }

  /** Runs a `_new`-style constructor into an opaque slot and returns the handle. */
  construct(create: (slot: number) => number): number {
    const slot = this.e.ghostty_wasm_alloc_opaque();
    if (slot === 0) {
      throw new Error("libghostty-vt: out of wasm memory (opaque)");
    }
    try {
      const rc = create(slot);
      if (rc !== SUCCESS) {
        throw new Error(`libghostty-vt: construction failed (rc=${rc})`);
      }
      return this.e.ghostty_wasm_take_opaque(slot);
    } finally {
      this.e.ghostty_wasm_free_opaque(slot);
    }
  }

  /**
   * A scratch slot holding {@code handle} — the `&handle` a bind call (`render_state_get` with a
   * row iterator, `render_state_row_get` with cells) requires. The caller frees it.
   */
  handleSlot(handle: number): number {
    const ptr = this.alloc(4);
    this.view().setUint32(ptr, handle, true);
    return ptr;
  }

  writeInto(bytes: Uint8Array): number {
    const ptr = this.alloc(bytes.length);
    this.u8().set(bytes, ptr);
    return ptr;
  }

  readU16(ptr: number): number {
    return this.view().getUint16(ptr, true);
  }

  readU32(ptr: number): number {
    return this.view().getUint32(ptr, true);
  }

  readU8(ptr: number): number {
    return this.u8()[ptr];
  }

  readRgb(ptr: number): Rgb {
    const m = this.u8();
    return [m[ptr], m[ptr + 1], m[ptr + 2]];
  }

  /** The live byte view of wasm memory; re-acquire after any wasm call that may grow memory. */
  bytes(): Uint8Array {
    return this.u8();
  }
}

/**
 * One terminal: create it with a size, feed it PTY bytes, read the grid, resize, and free it. Not
 * thread-safe (JS is single-threaded; drive it from one place). Every VtCore owns its terminal,
 * render state, and reusable iterators inside a single wasm instance.
 */
export class VtCore {
  private readonly abi: Abi;
  private readonly term: number;
  private readonly state: number;
  private readonly rowIter: number;
  private readonly cells: number;
  private cols: number;
  private rows: number;
  private freed = false;

  private readonly fg: Rgb;
  private readonly bg: Rgb;

  private constructor(
    private readonly e: GhosttyExports,
    cols: number,
    rows: number,
    theme: Theme,
  ) {
    this.abi = new Abi(e);
    this.cols = cols;
    this.rows = rows;
    this.fg = theme.fg;
    this.bg = theme.bg;
    this.term = this.abi.construct((slot) => e.ghostty_terminal_new(0, slot, cols, rows));
    this.configure(theme);
    this.state = this.abi.construct((slot) => e.ghostty_render_state_new(0, slot));
    this.rowIter = this.abi.construct((slot) => e.ghostty_render_state_row_iterator_new(0, slot));
    this.cells = this.abi.construct((slot) => e.ghostty_render_state_row_cells_new(0, slot));
  }

  /**
   * Installs the theme into libghostty: the default fg/bg/cursor, and a 256-color palette whose 16
   * base entries are the embedder's ANSI colors (the rest left at ghostty's defaults). Indexed SGR
   * colors then resolve to the embedder's design; true-color and default cells are unaffected.
   */
  private configure(theme: Theme): void {
    this.setColor(OPT_COLOR_FOREGROUND, theme.fg);
    this.setColor(OPT_COLOR_BACKGROUND, theme.bg);
    this.setColor(OPT_COLOR_CURSOR, theme.cursor);

    const ptr = this.abi.alloc(256 * 3);
    try {
      this.e.ghostty_color_palette_default(ptr);
      const mem = this.abi.bytes();
      theme.palette.slice(0, 16).forEach((c, i) => {
        mem[ptr + i * 3] = c[0];
        mem[ptr + i * 3 + 1] = c[1];
        mem[ptr + i * 3 + 2] = c[2];
      });
      this.e.ghostty_terminal_set(this.term, OPT_COLOR_PALETTE, ptr);
    } finally {
      this.abi.free(ptr, 256 * 3);
    }
  }

  private setColor(option: number, rgb: Rgb): void {
    const ptr = this.abi.alloc(3);
    try {
      const mem = this.abi.bytes();
      mem[ptr] = rgb[0];
      mem[ptr + 1] = rgb[1];
      mem[ptr + 2] = rgb[2];
      this.e.ghostty_terminal_set(this.term, option, ptr);
    } finally {
      this.abi.free(ptr, 3);
    }
  }

  /**
   * Instantiates the wasm and creates a terminal of {@code cols}×{@code rows}. {@code wasm} is the
   * raw module bytes — injected by the caller (a bundled asset in the app, the vendored file in
   * tests), so VtCore never depends on where the wasm lives.
   */
  static async create(
    wasm: BufferSource,
    cols: number,
    rows: number,
    theme: Theme = DEFAULT_THEME,
  ): Promise<VtCore> {
    if (cols <= 0 || rows <= 0 || cols > MAX_DIM || rows > MAX_DIM) {
      throw new Error(`VtCore: cols and rows must be in 1..${MAX_DIM} (got ${cols}x${rows})`);
    }
    const module = await WebAssembly.compile(wasm);
    const instance = await WebAssembly.instantiate(module, {});
    return new VtCore(instance.exports as unknown as GhosttyExports, cols, rows, theme);
  }

  /** Feeds PTY output bytes to the terminal, advancing its state. */
  write(bytes: Uint8Array): void {
    this.requireOpen();
    if (bytes.length === 0) {
      return;
    }
    const ptr = this.abi.writeInto(bytes);
    try {
      this.e.ghostty_terminal_vt_write(this.term, ptr, bytes.length);
    } finally {
      this.abi.free(ptr, bytes.length);
    }
  }

  /** Resizes the terminal; libghostty-vt reflows internally. Cell pixel size is not tracked here. */
  resize(cols: number, rows: number): void {
    this.requireOpen();
    if (cols <= 0 || rows <= 0 || cols > MAX_DIM || rows > MAX_DIM) {
      throw new Error(`VtCore.resize: cols and rows must be in 1..${MAX_DIM} (got ${cols}x${rows})`);
    }
    const rc = this.e.ghostty_terminal_resize(this.term, cols, rows, 0, 0);
    if (rc !== SUCCESS) {
      throw new Error(`VtCore.resize failed (rc=${rc})`);
    }
    this.cols = cols;
    this.rows = rows;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /**
   * The rows that changed since the last {@link clean}, with resolved colors — the renderer's
   * input. On a full-dirty state (e.g. the first read or a resize) every row is returned. Reading
   * does not clear damage; call {@link clean} once the frame is drawn.
   */
  snapshot(): GridSnapshot {
    this.requireOpen();
    this.refresh();
    const dirty = this.dirtyKind();
    if (dirty === "none") {
      return { dirty, rows: [] };
    }
    const rows = this.readDirtyRows();
    return { dirty, rows };
  }

  /**
   * Like {@link snapshot} but every viewport row is returned when anything changed, not just the
   * dirty ones. A renderer that repaints from this can never drift from the terminal: partial damage
   * describes which cells changed, but not a scroll's row shift, so applying only dirty rows leaves a
   * persistent grid misaligned after a scroll. {@link Dirty} still reports whether anything changed,
   * so an idle frame stays free.
   */
  fullSnapshot(): GridSnapshot {
    this.requireOpen();
    this.refresh();
    const dirty = this.dirtyKind();
    if (dirty === "none") {
      return { dirty, rows: [] };
    }
    return { dirty, rows: this.readAllRows() };
  }

  /**
   * The whole viewport, unconditionally — the render path when the caller already knows bytes
   * arrived. libghostty-vt only flags damage on a scroll, not on an in-place edit (readline echoing
   * a keystroke, a one-line command's output), so a renderer that trusts {@link snapshot}'s dirty
   * gate silently drops those. This ignores the gate and reads every row, so nothing is missed.
   */
  readAll(): GridSnapshot {
    this.requireOpen();
    this.refresh();
    return { dirty: "full", rows: this.readAllRows() };
  }

  /** The cursor's viewport position and visibility. */
  cursor(): Cursor {
    this.requireOpen();
    this.refresh();
    const present = this.getBool(RS_DATA_CURSOR_VIEWPORT_HAS_VALUE);
    if (!present) {
      return { present: false, x: 0, y: 0, visible: false };
    }
    return {
      present: true,
      x: this.getU16(RS_DATA_CURSOR_VIEWPORT_X),
      y: this.getU16(RS_DATA_CURSOR_VIEWPORT_Y),
      visible: this.getBool(RS_DATA_CURSOR_VISIBLE),
    };
  }

  /** Clears damage so the next {@link snapshot} reports only what changes after this point. */
  clean(): void {
    this.requireOpen();
    this.e.ghostty_render_state_clean(this.state);
  }

  /** Frees the terminal, render state, and iterators. Idempotent. */
  free(): void {
    if (this.freed) {
      return;
    }
    this.freed = true;
    this.e.ghostty_render_state_row_cells_free(this.cells);
    this.e.ghostty_render_state_row_iterator_free(this.rowIter);
    this.e.ghostty_render_state_free(this.state);
    this.e.ghostty_terminal_free(this.term);
  }

  private refresh(): void {
    const rc = this.e.ghostty_render_state_update(this.state, this.term);
    if (rc !== SUCCESS) {
      throw new Error(`VtCore: render_state_update failed (rc=${rc})`);
    }
  }

  private dirtyKind(): Dirty {
    const value = this.getU8(RS_DATA_DIRTY);
    if (value === DIRTY_FALSE) {
      return "none";
    }
    return value === DIRTY_PARTIAL ? "partial" : "full";
  }

  private readDirtyRows(): Row[] {
    const rows: Row[] = [];
    this.bindRowIterator();
    const yPtr = this.abi.alloc(2);
    try {
      while (this.e.ghostty_render_state_row_iterator_next_dirty(this.rowIter, yPtr)) {
        const y = this.abi.readU16(yPtr);
        rows.push({ y, cells: this.readRowCells() });
      }
    } finally {
      this.abi.free(yPtr, 2);
    }
    return rows;
  }

  private readAllRows(): Row[] {
    const rows: Row[] = [];
    this.bindRowIterator();
    let y = 0;
    while (this.e.ghostty_render_state_row_iterator_next(this.rowIter)) {
      rows.push({ y, cells: this.readRowCells() });
      y++;
    }
    return rows;
  }

  private readRowCells(): Cell[] {
    this.bindCells();
    const cells: Cell[] = [];
    const lenPtr = this.abi.alloc(4);
    const fgPtr = this.abi.alloc(4);
    const bgPtr = this.abi.alloc(4);
    const stylePtr = this.abi.alloc(STYLE_SIZE);
    try {
      while (this.e.ghostty_render_state_row_cells_next(this.cells)) {
        const style = this.readStyle(fgPtr, stylePtr);
        const fg = this.readColor(CELLS_DATA_FG_COLOR, fgPtr);
        const bg = this.readColor(CELLS_DATA_BG_COLOR, bgPtr);
        cells.push({
          text: this.readGrapheme(lenPtr),
          fg: style.inverse ? bg : fg,
          bg: style.inverse ? fg : bg,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
          strikethrough: style.strikethrough,
          faint: style.faint,
        });
      }
    } finally {
      this.abi.free(lenPtr, 4);
      this.abi.free(fgPtr, 4);
      this.abi.free(bgPtr, 4);
      this.abi.free(stylePtr, STYLE_SIZE);
    }
    return cells;
  }

  /**
   * The cell's SGR style. Fast-pathed on HAS_STYLING so a plain cell (the common case) costs one
   * bool read; a styled cell reads the {@code GhosttyStyle} struct and extracts the flags at their
   * (wasm-confirmed) offsets. {@code scratch} is a reusable 1-byte-plus scratch buffer.
   */
  private readStyle(scratch: number, stylePtr: number): CellStyle {
    if (
      this.e.ghostty_render_state_row_cells_get(this.cells, CELLS_DATA_HAS_STYLING, scratch) !==
        SUCCESS ||
      this.abi.readU8(scratch) === 0
    ) {
      return { ...PLAIN };
    }
    const zero = this.abi.bytes();
    for (let i = 0; i < STYLE_SIZE; i++) zero[stylePtr + i] = 0;
    new DataView(this.e.memory.buffer).setUint32(stylePtr, STYLE_SIZE, true);
    if (
      this.e.ghostty_render_state_row_cells_get(this.cells, CELLS_DATA_STYLE, stylePtr) !== SUCCESS
    ) {
      return { ...PLAIN };
    }
    const m = this.abi.bytes();
    const dv = new DataView(this.e.memory.buffer);
    return {
      bold: m[stylePtr + STYLE_BOLD] !== 0,
      italic: m[stylePtr + STYLE_ITALIC] !== 0,
      faint: m[stylePtr + STYLE_FAINT] !== 0,
      inverse: m[stylePtr + STYLE_INVERSE] !== 0,
      strikethrough: m[stylePtr + STYLE_STRIKETHROUGH] !== 0,
      underline: dv.getInt32(stylePtr + STYLE_UNDERLINE, true) > 0,
    };
  }

  private readGrapheme(lenPtr: number): string {
    if (this.e.ghostty_render_state_row_cells_get(this.cells, CELLS_DATA_GRAPHEMES_LEN, lenPtr) !== SUCCESS) {
      return "";
    }
    const count = this.abi.readU32(lenPtr);
    if (count === 0) {
      return "";
    }
    const buf = this.abi.alloc(count * 4);
    try {
      if (this.e.ghostty_render_state_row_cells_get(this.cells, CELLS_DATA_GRAPHEMES_BUF, buf) !== SUCCESS) {
        return "";
      }
      let text = "";
      for (let i = 0; i < count; i++) {
        text += String.fromCodePoint(this.abi.readU32(buf + i * 4));
      }
      return text;
    } finally {
      this.abi.free(buf, count * 4);
    }
  }

  /**
   * A cell's resolved fg or bg. libghostty returns non-SUCCESS (GHOSTTY_INVALID_VALUE) for a cell
   * that carries no explicit color — the "use the terminal default" case — so we substitute the
   * theme color; an explicit color (palette-resolved or true-color) is returned as-is, even black.
   */
  private readColor(kind: number, ptr: number): Rgb {
    const fallback = kind === CELLS_DATA_FG_COLOR ? this.fg : this.bg;
    if (this.e.ghostty_render_state_row_cells_get(this.cells, kind, ptr) !== SUCCESS) {
      return fallback;
    }
    return this.abi.readRgb(ptr);
  }

  private bindRowIterator(): void {
    const slot = this.abi.handleSlot(this.rowIter);
    try {
      const rc = this.e.ghostty_render_state_get(this.state, RS_DATA_ROW_ITERATOR, slot);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: binding the row iterator failed (rc=${rc})`);
      }
    } finally {
      this.abi.free(slot, 4);
    }
  }

  private bindCells(): void {
    const slot = this.abi.handleSlot(this.cells);
    try {
      const rc = this.e.ghostty_render_state_row_get(this.rowIter, ROW_DATA_CELLS, slot);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: binding the row cells failed (rc=${rc})`);
      }
    } finally {
      this.abi.free(slot, 4);
    }
  }

  private getU8(data: number): number {
    const ptr = this.abi.alloc(1);
    try {
      const rc = this.e.ghostty_render_state_get(this.state, data, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading scalar ${data} failed (rc=${rc})`);
      }
      return this.abi.readU8(ptr);
    } finally {
      this.abi.free(ptr, 1);
    }
  }

  private getU16(data: number): number {
    const ptr = this.abi.alloc(2);
    try {
      const rc = this.e.ghostty_render_state_get(this.state, data, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading scalar ${data} failed (rc=${rc})`);
      }
      return this.abi.readU16(ptr);
    } finally {
      this.abi.free(ptr, 2);
    }
  }

  private getBool(data: number): boolean {
    return this.getU8(data) !== 0;
  }

  private requireOpen(): void {
    if (this.freed) {
      throw new Error("VtCore: this terminal has been freed");
    }
  }
}
