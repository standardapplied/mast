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

import type { KeyEventSpec } from "./input";
import { installCallbacks } from "./wasmCallbacks";

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** A resolved 8-bit RGB triple, already accounting for the palette. */
export type Rgb = readonly [number, number, number];

/** SGR 4:x underline styles, as libghostty reports them. */
export type UnderlineStyle = "none" | "single" | "double" | "curly" | "dotted" | "dashed";

/** One rendered cell: text (a grapheme cluster), resolved colors, and SGR style. Colors already
 *  account for reverse video (fg/bg are swapped when the cell is inverse). */
export interface Cell {
  readonly text: string;
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: UnderlineStyle;
  /** SGR 58 underline color, resolved; null means "same as the text". */
  readonly underlineColor: Rgb | null;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly faint: boolean;
  /** SGR 8: the cell has text but must not show it. */
  readonly invisible: boolean;
  /** Inside the terminal's active selection. */
  readonly selected: boolean;
  /** Display columns the grapheme occupies: 2 for wide (CJK/emoji), else 1. */
  readonly width: number;
}

/** A cell position in the viewport. */
export interface CellPos {
  readonly x: number;
  readonly y: number;
}

/** A pointer position in surface pixels — the same unit as {@link VtCore.setCellPixels}. */
export interface SurfacePos {
  readonly x: number;
  readonly y: number;
}

/** A cell with no styling, before colors are filled in — the common case (plain text). */
const PLAIN: CellStyle = {
  bold: false,
  italic: false,
  underline: "none",
  underlineColor: null,
  strikethrough: false,
  overline: false,
  faint: false,
  invisible: false,
  inverse: false,
};

interface CellStyle {
  bold: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  underlineColor: Rgb | null;
  strikethrough: boolean;
  overline: boolean;
  faint: boolean;
  invisible: boolean;
  inverse: boolean;
}

const UNDERLINE_STYLES: readonly UnderlineStyle[] = [
  "none",
  "single",
  "double",
  "curly",
  "dotted",
  "dashed",
];

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

/** DECSCUSR shapes; "hollow" is what an unfocused terminal shows. */
export type CursorStyle = "bar" | "block" | "underline" | "hollow";

/** The cursor's viewport position, shape and visibility; {@link present} is false when off-screen. */
export interface Cursor {
  readonly present: boolean;
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly style: CursorStyle;
  /** Whether the application wants it to blink (DECSCUSR odd values, mode 12). */
  readonly blinking: boolean;
}

/** GhosttyRenderStateCursorVisualStyle values, in enum order. */
const CURSOR_STYLES: readonly CursorStyle[] = ["bar", "block", "underline", "hollow"];

/** What the embedder looks like to the application: light or dark (CSI ? 996 n). */
export type ColorScheme = "light" | "dark";

export type MouseAction = keyof typeof MOUSE_ACTIONS;
export type MouseButton = keyof typeof MOUSE_BUTTONS;

/** A mouse event in cell coordinates; {@code mods} uses the key encoder's GhosttyMods bits. */
export interface MouseEventSpec {
  readonly action: MouseAction;
  /** The button pressed, released, or held during motion; absent for plain motion. */
  readonly button?: MouseButton;
  readonly mods: number;
  readonly x: number;
  readonly y: number;
}

export interface VtCoreOptions {
  /** The XTVERSION reply (CSI > q), e.g. "mast 0.1.80". */
  readonly identity?: string;
  readonly scheme?: ColorScheme;
}

/**
 * The terminal's side effects, delivered synchronously from inside {@link VtCore.write}. Replies
 * the application asked for (device attributes, cursor position, mode reports, kitty flags,
 * XTVERSION, color queries, size reports) arrive on {@link onWritePty} and belong in the pty.
 */
export interface VtCoreHooks {
  onWritePty?: (bytes: Uint8Array) => void;
  onTitle?: (title: string) => void;
  /** OSC 52 (and kitty OSC 5522) writes; an empty string clears the clipboard. */
  onClipboard?: (text: string) => void;
  onBell?: () => void;
}

const SUCCESS = 0;
const OUT_OF_SPACE = -3;

/** GhosttyTerminalData discriminant for a mode query (GHOSTTY_TERMINAL_DATA_MODE). */
const DATA_MODE = 37;
/** DEC private mode 2004 — bracketed paste. */
const MODE_BRACKETED_PASTE = 2004;
/** The alternate-screen modes (1049 modern, 1047/47 legacy) — any one means a full-screen TUI. */
const MODES_ALT_SCREEN = [1049, 1047, 47] as const;
/** DEC private mode 1004 — focus event reporting. */
const MODE_FOCUS_REPORTING = 1004;
/** DEC private mode 2026 — synchronized output: hold frames until the app finishes a redraw. */
const MODE_SYNCHRONIZED_OUTPUT = 2026;
/** The mouse tracking modes (X10, normal, button-event, any-event) — any one means the app wants the mouse. */
const MODES_MOUSE_TRACKING = [9, 1000, 1002, 1003] as const;
/** GhosttyMouseAction / GhosttyMouseButton values. */
const MOUSE_ACTIONS = { press: 0, release: 1, motion: 2 } as const;
const MOUSE_BUTTONS = { left: 1, right: 2, middle: 3, wheelUp: 4, wheelDown: 5 } as const;
/** GhosttyMouseEncoderOption values and the GhosttyMouseEncoderSize struct (size_t + 8 × u32). */
const MOUSE_OPT_SIZE = 2;
const MOUSE_OPT_ANY_BUTTON_PRESSED = 3;
const MOUSE_SIZE_STRUCT = 36;
/** GhosttyMousePosition {float x, float y}, passed by pointer on wasm32. */
const MOUSE_POSITION_STRUCT = 8;
/** Mouse reports are a few bytes; one retry covers the out-of-space contract regardless. */
const MOUSE_BUF_LEN = 32;
/** GhosttyFocusEvent values. */
const FOCUS_GAINED = 0;
const FOCUS_LOST = 1;
/** GhosttyTerminalModeConfig: u16 mode + bool value, padded (frozen layout). */
const MODE_CONFIG_SIZE = 4;
const MODE_CONFIG_VALUE_OFFSET = 2;
/** `ESC[200~` + `ESC[201~` around a bracketed paste. */
const PASTE_FRAME_OVERHEAD = 12;

/** GhosttyKeyEncoderOption: macOS option-as-alt (an int-typed enum; TRUE = 1). */
const KEY_OPT_MACOS_OPTION_AS_ALT = 6;
const OPTION_AS_ALT_TRUE = 1;
/** Encoded key sequences are tiny; one retry handles the out-of-space contract regardless. */
const KEY_BUF_LEN = 64;

// Terminal dimensions are u16 inside libghostty-vt; reject anything that would
// truncate, so the cached size can never disagree with the real grid.
const MAX_DIM = 65535;

// Enum values from ghostty/vt/render.h (build 1.3.2 +d9840f3), pinned alongside the wasm.
const RS_DATA_DIRTY = 3;
const RS_DATA_ROW_ITERATOR = 4;
const RS_DATA_COLOR_PALETTE = 9;
const RS_DATA_CURSOR_VISUAL_STYLE = 10;
const RS_DATA_CURSOR_VISIBLE = 11;
const RS_DATA_CURSOR_BLINKING = 12;
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

// GhosttyStyle field byte offsets (wasm32) and struct size, confirmed against the wasm. Three
// 16-byte GhosttyStyleColor tagged unions (tag u32, then an 8-byte value: palette u8 or rgb) follow
// the size_t; the bool flags follow those; `underline` is a GhosttySgrUnderline int.
const STYLE_SIZE = 72;
const STYLE_UNDERLINE_COLOR_TAG = 40;
const STYLE_UNDERLINE_COLOR_VALUE = 48;
const STYLE_BOLD = 56;
const STYLE_ITALIC = 57;
const STYLE_FAINT = 58;
const STYLE_INVERSE = 60;
const STYLE_INVISIBLE = 61;
const STYLE_STRIKETHROUGH = 62;
const STYLE_OVERLINE = 63;
const STYLE_UNDERLINE = 64;
const STYLE_COLOR_PALETTE = 1;
const STYLE_COLOR_RGB = 2;
const PALETTE_BYTES = 256 * 3;
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
const OPT_DEFAULT_CURSOR_BLINK = 23;
const OPT_SCROLLBACK_MAX_BYTES = 27;
/** GHOSTTY_TERMINAL_DATA_SCROLLBACK_MAX_BYTES (size_t). */
const DATA_SCROLLBACK_MAX_BYTES = 34;
/** GHOSTTY_TERMINAL_DATA_VIEWPORT_ACTIVE (bool): the viewport follows the active area. */
const DATA_VIEWPORT_ACTIVE = 32;
/** The terminal's active selection: set with a GhosttySelection* (NULL clears), read back the same. */
const OPT_SELECTION = 21;
const DATA_SELECTION = 31;
const CELLS_DATA_SELECTED = 7;
// GhosttyPoint (wasm32): tag u32 @0; coordinate union @8 (x u16 @8, y u32 @12); 24 bytes.
const POINT_SIZE = 24;
const POINT_TAG_VIEWPORT = 1;
const POINT_X = 8;
const POINT_Y = 12;
// GhosttyGridRef: {size_t size, void* node, u16 x, u16 y} = 12 bytes.
const GRID_REF_SIZE = 12;
// GhosttySelection: {size_t size, GhosttyGridRef start, GhosttyGridRef end, bool rectangle} → 32.
const SELECTION_SIZE = 32;
// GhosttySelectionGestureEventType / ...EventOption values.
const GESTURE_PRESS = 0;
const GESTURE_RELEASE = 1;
const GESTURE_DRAG = 2;
const GESTURE_OPT_REF = 0;
const GESTURE_OPT_POSITION = 1;
const GESTURE_OPT_REPEAT_DISTANCE = 2;
const GESTURE_OPT_TIME_NS = 3;
const GESTURE_OPT_REPEAT_INTERVAL_NS = 4;
const GESTURE_OPT_GEOMETRY = 8;
/** GhosttySurfacePosition {double x, double y}; GhosttySelectionGestureGeometry {4 × u32}. */
const SURFACE_POSITION_SIZE = 16;
const GEOMETRY_SIZE = 16;
/** Double/triple-click detection: repeats within this distance and interval count as one gesture. */
const REPEAT_DISTANCE_PX = 8;
const REPEAT_INTERVAL_NS = 500_000_000n;
/** GhosttyTerminalSelectionFormatOptions: {size_t size, format @4, unwrap @8, trim @9, selection* @12}. */
const FORMAT_OPTIONS_SIZE = 16;
const FORMAT_PLAIN = 0;
const NO_VALUE = -4;
/**
 * Scrollback budget per terminal. libghostty-vt's own default is 10 KB (a few hundred lines);
 * native Ghostty configures 50 MB. Memory is allocated only as output accumulates.
 */
export const SCROLLBACK_MAX_BYTES = 20 * 1024 * 1024;
/** Effect callbacks: the value passed to ghostty_terminal_set is the function-table index. */
const OPT_WRITE_PTY = 1;
const OPT_BELL = 2;
const OPT_XTVERSION = 4;
const OPT_TITLE_CHANGED = 5;
const OPT_SIZE = 6;
const OPT_COLOR_SCHEME = 7;
const OPT_CLIPBOARD_WRITE = 26;
/** GHOSTTY_TERMINAL_DATA_TITLE: a borrowed GhosttyString {ptr, len}. */
const DATA_TITLE = 12;
const STRING_SIZE = 8;
const COLOR_SCHEME_LIGHT = 0;
const COLOR_SCHEME_DARK = 1;
// GhosttyClipboardWrite (wasm32, confirmed against the wasm): contents array + reply fn pointer.
const CLIP_CONTENTS = 8;
const CLIP_CONTENTS_LEN = 12;
const CLIP_REPLY_FN = 32;
/** GhosttyClipboardContent: {mime: GhosttyString, data: GhosttyString}. */
const CLIP_CONTENT_SIZE = 16;
const CLIP_CONTENT_DATA = 8;
/** GhosttyClipboardWriteReply: {size_t size, result enum, bool remember}. */
const CLIP_REPLY_SIZE = 12;
const CLIP_RESULT_SUCCESS = 0;
const TEXT_PLAIN = "text/plain";
// GhosttySizeReportSize: {u16 rows, u16 columns, u32 cell_width, u32 cell_height}.
const SIZE_ROWS = 0;
const SIZE_COLS = 2;
const SIZE_CELL_W = 4;
const SIZE_CELL_H = 8;

// GhosttyTerminalScrollViewport: a 24-byte tagged union {tag: u32 @0, value @8}.
const SCROLL_STRUCT_SIZE = 24;
const SCROLL_TOP = 0;
const SCROLL_BOTTOM = 1;
const SCROLL_DELTA = 2;

/** How to move the viewport: to the top/bottom of scrollback, or by a signed line delta (up < 0). */
export type Scroll = "top" | "bottom" | { readonly delta: number };

/** The subset of libghostty-vt exports VtCore drives. */
interface GhosttyExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_wasm_free_opaque(slot: number): void;
  ghostty_terminal_new(alloc: number, out: number, cols: number, rows: number): number;
  ghostty_terminal_set(term: number, option: number, value: number): number;
  ghostty_key_encoder_new(alloc: number, out: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt(encoder: number, option: number, valuePtr: number): void;
  ghostty_key_encoder_setopt_from_terminal(encoder: number, term: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    buf: number,
    bufLen: number,
    outLen: number,
  ): number;
  ghostty_key_event_new(alloc: number, out: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void;
  ghostty_key_event_set_composing(event: number, composing: number): void;
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;
  ghostty_mouse_event_new(alloc: number, out: number): number;
  ghostty_mouse_event_free(event: number): void;
  ghostty_mouse_event_set_action(event: number, action: number): void;
  ghostty_mouse_event_set_button(event: number, button: number): void;
  ghostty_mouse_event_clear_button(event: number): void;
  ghostty_mouse_event_set_mods(event: number, mods: number): void;
  ghostty_mouse_event_set_position(event: number, positionPtr: number): void;
  ghostty_mouse_encoder_new(alloc: number, out: number): number;
  ghostty_mouse_encoder_free(encoder: number): void;
  ghostty_mouse_encoder_setopt(encoder: number, option: number, valuePtr: number): void;
  ghostty_mouse_encoder_setopt_from_terminal(encoder: number, term: number): void;
  ghostty_mouse_encoder_encode(
    encoder: number,
    event: number,
    buf: number,
    bufLen: number,
    outLen: number,
  ): number;
  ghostty_terminal_get(term: number, data: number, out: number): number;
  ghostty_terminal_reset(term: number): void;
  ghostty_focus_encode(event: number, buf: number, bufLen: number, outWritten: number): number;
  ghostty_paste_encode(
    data: number,
    dataLen: number,
    bracketed: number,
    buf: number,
    bufLen: number,
    outWritten: number,
  ): number;
  ghostty_terminal_scroll_viewport(term: number, behavior: number): void;
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
  ghostty_unicode_grapheme_width(cps: number, len: number, outWidth: number): number;
  ghostty_terminal_grid_ref(term: number, pointPtr: number, outRef: number): number;
  ghostty_selection_gesture_new(alloc: number, out: number): number;
  ghostty_selection_gesture_free(gesture: number, term: number): void;
  ghostty_selection_gesture_reset(gesture: number, term: number): void;
  ghostty_selection_gesture_event(
    gesture: number,
    term: number,
    event: number,
    outSelection: number,
  ): number;
  ghostty_selection_gesture_event_new(alloc: number, out: number, type: number): number;
  ghostty_selection_gesture_event_free(event: number): void;
  ghostty_selection_gesture_event_set(event: number, option: number, valuePtr: number): number;
  ghostty_terminal_selection_format_alloc(
    term: number,
    alloc: number,
    optionsPtr: number,
    outPtr: number,
    outLen: number,
  ): number;
  ghostty_free(alloc: number, ptr: number, len: number): void;
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

  writeU16(ptr: number, value: number): void {
    this.view().setUint16(ptr, value, true);
  }

  writeI32(ptr: number, value: number): void {
    this.view().setInt32(ptr, value, true);
  }

  writeU32(ptr: number, value: number): void {
    this.view().setUint32(ptr, value, true);
  }

  /** A GhosttyString {ptr, len} at {@code ptr}, decoded as UTF-8. */
  readString(ptr: number): string {
    const start = this.readU32(ptr);
    const len = this.readU32(ptr + 4);
    return UTF8_DECODER.decode(this.u8().subarray(start, start + len));
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

  private readonly keyEncoder: number;
  private readonly keyEvent: number;
  private readonly optAsAltPtr: number;
  private readonly mouseEncoder: number;
  private readonly mouseEvent: number;
  private readonly gesture: number;
  private readonly pressEvent: number;
  private readonly dragEvent: number;
  private readonly releaseEvent: number;

  private readonly fg: Rgb;
  private readonly bg: Rgb;
  private readonly scheme: ColorScheme;
  private readonly identityPtr: number;
  private readonly identityLen: number;
  private cellPx = { w: 0, h: 0 };

  /** Side effects of the stream; the embedder wires them (see {@link VtCoreHooks}). */
  readonly hooks: VtCoreHooks = {};

  private constructor(
    private readonly e: GhosttyExports,
    cols: number,
    rows: number,
    theme: Theme,
    options: VtCoreOptions,
  ) {
    this.abi = new Abi(e);
    this.cols = cols;
    this.rows = rows;
    this.fg = theme.fg;
    this.bg = theme.bg;
    this.scheme = options.scheme ?? "dark";
    const identity = UTF8.encode(options.identity ?? "mast");
    this.identityPtr = this.abi.writeInto(identity);
    this.identityLen = identity.length;
    this.term = this.abi.construct((slot) => e.ghostty_terminal_new(0, slot, cols, rows));
    this.configure(theme);
    this.state = this.abi.construct((slot) => e.ghostty_render_state_new(0, slot));
    this.rowIter = this.abi.construct((slot) => e.ghostty_render_state_row_iterator_new(0, slot));
    this.cells = this.abi.construct((slot) => e.ghostty_render_state_row_cells_new(0, slot));
    this.keyEncoder = this.abi.construct((slot) => e.ghostty_key_encoder_new(0, slot));
    this.keyEvent = this.abi.construct((slot) => e.ghostty_key_event_new(0, slot));
    this.optAsAltPtr = this.abi.alloc(4);
    this.abi.writeI32(this.optAsAltPtr, OPTION_AS_ALT_TRUE);
    this.setOptionAsAlt();
    this.mouseEncoder = this.abi.construct((slot) => e.ghostty_mouse_encoder_new(0, slot));
    this.mouseEvent = this.abi.construct((slot) => e.ghostty_mouse_event_new(0, slot));
    this.gesture = this.abi.construct((slot) => e.ghostty_selection_gesture_new(0, slot));
    this.pressEvent = this.newGestureEvent(GESTURE_PRESS);
    this.dragEvent = this.newGestureEvent(GESTURE_DRAG);
    this.releaseEvent = this.newGestureEvent(GESTURE_RELEASE);
    this.configureRepeatClicks();
  }

  private newGestureEvent(type: number): number {
    return this.abi.construct((slot) => this.e.ghostty_selection_gesture_event_new(0, slot, type));
  }

  /** Multi-click detection is off in libghostty until a distance and an interval are given. */
  private configureRepeatClicks(): void {
    const distance = this.abi.alloc(8);
    const interval = this.abi.alloc(8);
    try {
      const dv = new DataView(this.e.memory.buffer);
      dv.setFloat64(distance, REPEAT_DISTANCE_PX, true);
      dv.setBigUint64(interval, REPEAT_INTERVAL_NS, true);
      this.gestureSet(this.pressEvent, GESTURE_OPT_REPEAT_DISTANCE, distance);
      this.gestureSet(this.pressEvent, GESTURE_OPT_REPEAT_INTERVAL_NS, interval);
    } finally {
      this.abi.free(distance, 8);
      this.abi.free(interval, 8);
    }
  }

  private gestureSet(event: number, option: number, valuePtr: number): void {
    const rc = this.e.ghostty_selection_gesture_event_set(event, option, valuePtr);
    if (rc !== SUCCESS) {
      throw new Error(`VtCore: gesture option ${option} rejected (rc=${rc})`);
    }
  }

  /** A bool option on the mouse encoder. */
  private setMouseBool(option: number, value: boolean): void {
    const ptr = this.abi.alloc(1);
    try {
      this.abi.bytes()[ptr] = value ? 1 : 0;
      this.e.ghostty_mouse_encoder_setopt(this.mouseEncoder, option, ptr);
    } finally {
      this.abi.free(ptr, 1);
    }
  }

  /**
   * Option is Alt (meta-sends-escape), the behavior this terminal has always had. Terminal state
   * cannot express this preference, so {@code setopt_from_terminal} resets it — re-apply after
   * every sync (the header documents exactly this dance). The value never changes, so it lives in
   * one preallocated slot rather than an alloc per keystroke.
   */
  private setOptionAsAlt(): void {
    this.e.ghostty_key_encoder_setopt(this.keyEncoder, KEY_OPT_MACOS_OPTION_AS_ALT, this.optAsAltPtr);
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
    this.setBool(OPT_DEFAULT_CURSOR_BLINK, true);
    this.setSize(OPT_SCROLLBACK_MAX_BYTES, SCROLLBACK_MAX_BYTES);

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

  /** A size_t option (u32 on wasm32). */
  private setSize(option: number, value: number): void {
    const ptr = this.abi.alloc(4);
    try {
      this.abi.writeU32(ptr, value);
      const rc = this.e.ghostty_terminal_set(this.term, option, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: setting option ${option} failed (rc=${rc})`);
      }
    } finally {
      this.abi.free(ptr, 4);
    }
  }

  /**
   * Whether the viewport is pinned to the live screen — false once the user has scrolled into
   * history, where new output lands below what they are looking at.
   */
  viewportActive(): boolean {
    this.requireOpen();
    const ptr = this.abi.alloc(1);
    try {
      const rc = this.e.ghostty_terminal_get(this.term, DATA_VIEWPORT_ACTIVE, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading the viewport state failed (rc=${rc})`);
      }
      return this.abi.readU8(ptr) !== 0;
    } finally {
      this.abi.free(ptr, 1);
    }
  }

  /** The scrollback budget in bytes the terminal is running with. */
  scrollbackMaxBytes(): number {
    this.requireOpen();
    const ptr = this.abi.alloc(4);
    try {
      const rc = this.e.ghostty_terminal_get(this.term, DATA_SCROLLBACK_MAX_BYTES, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading the scrollback limit failed (rc=${rc})`);
      }
      return this.abi.readU32(ptr);
    } finally {
      this.abi.free(ptr, 4);
    }
  }

  /** The cursor blinks unless the application says otherwise — Ghostty's default, and Mast's. */
  private setBool(option: number, value: boolean): void {
    const ptr = this.abi.alloc(1);
    try {
      this.abi.bytes()[ptr] = value ? 1 : 0;
      this.e.ghostty_terminal_set(this.term, option, ptr);
    } finally {
      this.abi.free(ptr, 1);
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
   * raw module bytes or an already-compiled module — injected by the caller (a bundled asset in the
   * app, compiled once and shared by every pane; the vendored file in tests), so VtCore never
   * depends on where the wasm lives. Each terminal gets its own instance and linear memory.
   */
  static async create(
    wasm: BufferSource | WebAssembly.Module,
    cols: number,
    rows: number,
    theme: Theme = DEFAULT_THEME,
    options: VtCoreOptions = {},
  ): Promise<VtCore> {
    if (cols <= 0 || rows <= 0 || cols > MAX_DIM || rows > MAX_DIM) {
      throw new Error(`VtCore: cols and rows must be in 1..${MAX_DIM} (got ${cols}x${rows})`);
    }
    const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
    const instance = await WebAssembly.instantiate(module, {});
    const core = new VtCore(instance.exports as unknown as GhosttyExports, cols, rows, theme, options);
    await core.installEffects();
    return core;
  }

  /**
   * Registers the terminal's effect callbacks. The wasm has no imports, so JS functions reach it
   * through the exported function table (see wasmCallbacks.ts); the table index is the C function
   * pointer. All of them fire synchronously from inside {@link write}.
   */
  private async installEffects(): Promise<void> {
    const abi = this.abi;
    const [writePty, bell, xtversion, title, size, scheme, clipboard] = await installCallbacks(
      this.e.__indirect_function_table,
      [
        {
          signature: { params: 4, result: false },
          fn: (_term, _userdata, ptr, len) =>
            this.hooks.onWritePty?.(abi.bytes().slice(ptr!, ptr! + len!)),
        },
        { signature: { params: 2, result: false }, fn: () => this.hooks.onBell?.() },
        {
          // GhosttyString is returned by value: wasm32 passes it as a hidden first pointer.
          signature: { params: 3, result: false },
          fn: (sret) => {
            abi.writeU32(sret!, this.identityPtr);
            abi.writeU32(sret! + 4, this.identityLen);
          },
        },
        { signature: { params: 2, result: false }, fn: () => this.hooks.onTitle?.(this.title()) },
        {
          signature: { params: 3, result: true },
          fn: (_term, _userdata, out) => {
            abi.writeU16(out! + SIZE_ROWS, this.rows);
            abi.writeU16(out! + SIZE_COLS, this.cols);
            abi.writeU32(out! + SIZE_CELL_W, this.cellPx.w);
            abi.writeU32(out! + SIZE_CELL_H, this.cellPx.h);
            return 1;
          },
        },
        {
          signature: { params: 3, result: true },
          fn: (_term, _userdata, out) => {
            abi.writeU32(out!, this.scheme === "dark" ? COLOR_SCHEME_DARK : COLOR_SCHEME_LIGHT);
            return 1;
          },
        },
        {
          signature: { params: 3, result: false },
          fn: (_term, _userdata, write) => this.clipboardWrite(write!),
        },
      ],
    );
    const effects: [number, number][] = [
      [OPT_WRITE_PTY, writePty!],
      [OPT_BELL, bell!],
      [OPT_XTVERSION, xtversion!],
      [OPT_TITLE_CHANGED, title!],
      [OPT_SIZE, size!],
      [OPT_COLOR_SCHEME, scheme!],
      [OPT_CLIPBOARD_WRITE, clipboard!],
    ];
    for (const [option, index] of effects) {
      const rc = this.e.ghostty_terminal_set(this.term, option, index);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: installing effect ${option} failed (rc=${rc})`);
      }
    }
  }

  /**
   * The pointer went down on {@code cell} at {@code px}: starts a selection gesture. A repeat click
   * within libghostty's repeat window widens the unit — a second click selects the word, a third
   * the line — and installs that selection at once. {@code timeMs} is the event's monotonic time.
   */
  selectionPress(cell: CellPos, px: SurfacePos, timeMs: number): void {
    this.requireOpen();
    this.withGridRef(cell, (ref) => {
      this.gestureSet(this.pressEvent, GESTURE_OPT_REF, ref);
      this.withSurfacePosition(px, (pos) => this.gestureSet(this.pressEvent, GESTURE_OPT_POSITION, pos));
      const time = this.abi.alloc(8);
      try {
        new DataView(this.e.memory.buffer).setBigUint64(time, BigInt(Math.round(timeMs * 1e6)), true);
        this.gestureSet(this.pressEvent, GESTURE_OPT_TIME_NS, time);
      } finally {
        this.abi.free(time, 8);
      }
      this.applyGesture(this.pressEvent);
    });
  }

  /** The pointer moved to {@code cell} at {@code px} with the button held: extends the selection. */
  selectionDrag(cell: CellPos, px: SurfacePos): void {
    this.requireOpen();
    this.withGridRef(cell, (ref) => {
      this.gestureSet(this.dragEvent, GESTURE_OPT_REF, ref);
      this.withSurfacePosition(px, (pos) => this.gestureSet(this.dragEvent, GESTURE_OPT_POSITION, pos));
      const geometry = this.abi.alloc(GEOMETRY_SIZE);
      try {
        const { w, h } = this.mouseCell();
        this.abi.writeU32(geometry, this.cols);
        this.abi.writeU32(geometry + 4, w);
        this.abi.writeU32(geometry + 8, 0);
        this.abi.writeU32(geometry + 12, this.rows * h);
        this.gestureSet(this.dragEvent, GESTURE_OPT_GEOMETRY, geometry);
      } finally {
        this.abi.free(geometry, GEOMETRY_SIZE);
      }
      this.applyGesture(this.dragEvent);
    });
  }

  /** The pointer came up: closes the gesture so the next press can count as a repeat click. */
  selectionRelease(cell: CellPos | null): void {
    this.requireOpen();
    if (cell === null) {
      this.applyGesture(this.releaseEvent);
      return;
    }
    this.withGridRef(cell, (ref) => {
      this.gestureSet(this.releaseEvent, GESTURE_OPT_REF, ref);
      this.applyGesture(this.releaseEvent);
    });
  }

  /** Drops the active selection and the gesture behind it. */
  clearSelection(): void {
    this.requireOpen();
    this.e.ghostty_selection_gesture_reset(this.gesture, this.term);
    const rc = this.e.ghostty_terminal_set(this.term, OPT_SELECTION, 0);
    if (rc !== SUCCESS) {
      throw new Error(`VtCore: clearing the selection failed (rc=${rc})`);
    }
  }

  /** Whether the terminal has an active selection. */
  hasSelection(): boolean {
    this.requireOpen();
    const ptr = this.abi.alloc(SELECTION_SIZE);
    try {
      this.abi.bytes().fill(0, ptr, ptr + SELECTION_SIZE);
      this.abi.writeU32(ptr, SELECTION_SIZE);
      return this.e.ghostty_terminal_get(this.term, DATA_SELECTION, ptr) === SUCCESS;
    } finally {
      this.abi.free(ptr, SELECTION_SIZE);
    }
  }

  /**
   * The active selection as plain text — trailing whitespace trimmed per line, wrapped rows kept
   * as one line, spanning scrollback and the screen alike. Empty when nothing is selected.
   */
  selectionText(): string {
    this.requireOpen();
    const options = this.abi.alloc(FORMAT_OPTIONS_SIZE);
    const outPtr = this.abi.alloc(4);
    const outLen = this.abi.alloc(4);
    try {
      this.abi.bytes().fill(0, options, options + FORMAT_OPTIONS_SIZE);
      this.abi.writeU32(options, FORMAT_OPTIONS_SIZE);
      this.abi.writeU32(options + 4, FORMAT_PLAIN);
      this.abi.bytes()[options + 8] = 1;
      this.abi.bytes()[options + 9] = 1;
      const rc = this.e.ghostty_terminal_selection_format_alloc(this.term, 0, options, outPtr, outLen);
      if (rc === NO_VALUE) {
        return "";
      }
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: formatting the selection failed (rc=${rc})`);
      }
      const ptr = this.abi.readU32(outPtr);
      const len = this.abi.readU32(outLen);
      try {
        return UTF8_DECODER.decode(this.abi.bytes().subarray(ptr, ptr + len));
      } finally {
        this.e.ghostty_free(0, ptr, len);
      }
    } finally {
      this.abi.free(outLen, 4);
      this.abi.free(outPtr, 4);
      this.abi.free(options, FORMAT_OPTIONS_SIZE);
    }
  }

  /** Runs a gesture event; a produced selection snapshot becomes the terminal's selection. */
  private applyGesture(event: number): void {
    const selection = this.abi.alloc(SELECTION_SIZE);
    try {
      this.abi.bytes().fill(0, selection, selection + SELECTION_SIZE);
      this.abi.writeU32(selection, SELECTION_SIZE);
      const rc = this.e.ghostty_selection_gesture_event(this.gesture, this.term, event, selection);
      if (rc === NO_VALUE) {
        return;
      }
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: selection gesture failed (rc=${rc})`);
      }
      const set = this.e.ghostty_terminal_set(this.term, OPT_SELECTION, selection);
      if (set !== SUCCESS) {
        throw new Error(`VtCore: installing the selection failed (rc=${set})`);
      }
    } finally {
      this.abi.free(selection, SELECTION_SIZE);
    }
  }

  /** A grid reference for a viewport cell, valid for the duration of {@code body}. */
  private withGridRef(cell: CellPos, body: (ref: number) => void): void {
    const point = this.abi.alloc(POINT_SIZE);
    const ref = this.abi.alloc(GRID_REF_SIZE);
    try {
      this.abi.bytes().fill(0, point, point + POINT_SIZE);
      this.abi.writeU32(point, POINT_TAG_VIEWPORT);
      this.abi.writeU16(point + POINT_X, Math.min(Math.max(0, cell.x), this.cols - 1));
      this.abi.writeU32(point + POINT_Y, Math.min(Math.max(0, cell.y), this.rows - 1));
      this.abi.bytes().fill(0, ref, ref + GRID_REF_SIZE);
      this.abi.writeU32(ref, GRID_REF_SIZE);
      const rc = this.e.ghostty_terminal_grid_ref(this.term, point, ref);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: no grid reference for cell (${cell.x}, ${cell.y}) (rc=${rc})`);
      }
      body(ref);
    } finally {
      this.abi.free(ref, GRID_REF_SIZE);
      this.abi.free(point, POINT_SIZE);
    }
  }

  private withSurfacePosition(px: SurfacePos, body: (pos: number) => void): void {
    const pos = this.abi.alloc(SURFACE_POSITION_SIZE);
    try {
      const dv = new DataView(this.e.memory.buffer);
      dv.setFloat64(pos, px.x, true);
      dv.setFloat64(pos + 8, px.y, true);
      body(pos);
    } finally {
      this.abi.free(pos, SURFACE_POSITION_SIZE);
    }
  }

  /** The cell size in pixels, reported to programs that ask (XTWINOPS 14/16 t, mode 2048). */
  setCellPixels(width: number, height: number): void {
    this.cellPx = { w: width, h: height };
  }

  /** The title the application set (OSC 0/2); empty when none. */
  title(): string {
    const out = this.abi.alloc(STRING_SIZE);
    try {
      const rc = this.e.ghostty_terminal_get(this.term, DATA_TITLE, out);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading the title failed (rc=${rc})`);
      }
      return this.abi.readString(out);
    } finally {
      this.abi.free(out, STRING_SIZE);
    }
  }

  /**
   * An OSC 52 write: the program's representations of one value; text/plain when offered, else
   * the first. Mast honors clipboard writes, so the reply is always success — the core sends the
   * program its acknowledgement (OSC 5522) through the pty writer.
   */
  private clipboardWrite(write: number): void {
    const abi = this.abi;
    const contents = abi.readU32(write + CLIP_CONTENTS);
    const count = abi.readU32(write + CLIP_CONTENTS_LEN);
    let text = "";
    for (let i = 0; i < count; i++) {
      const entry = contents + i * CLIP_CONTENT_SIZE;
      const mime = abi.readString(entry);
      if (i === 0 || mime === TEXT_PLAIN) {
        text = abi.readString(entry + CLIP_CONTENT_DATA);
      }
      if (mime === TEXT_PLAIN) break;
    }
    this.hooks.onClipboard?.(text);
    const reply = abi.alloc(CLIP_REPLY_SIZE);
    try {
      abi.bytes().fill(0, reply, reply + CLIP_REPLY_SIZE);
      abi.writeU32(reply, CLIP_REPLY_SIZE);
      abi.writeU32(reply + 4, CLIP_RESULT_SUCCESS);
      const replyFn = this.e.__indirect_function_table.get(abi.readU32(write + CLIP_REPLY_FN)) as
        | ((write: number, reply: number) => void)
        | null;
      if (!replyFn) {
        throw new Error("VtCore: the clipboard write carries no reply function");
      }
      replyFn(write, reply);
    } finally {
      abi.free(reply, CLIP_REPLY_SIZE);
    }
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

  /**
   * Encodes one key press into the bytes the pty expects, or null when the key produces nothing
   * (a bare modifier, an in-progress IME composition). Encoding is libghostty's own key encoder,
   * synced with the terminal's live state first — cursor-key application mode (DECCKM), the kitty
   * keyboard protocol, modifyOtherKeys — which is exactly what a hand-rolled table cannot honor.
   */
  encodeKey(spec: KeyEventSpec): Uint8Array | null {
    this.requireOpen();
    if (spec.composing) {
      return null;
    }
    const e = this.e;
    e.ghostty_key_encoder_setopt_from_terminal(this.keyEncoder, this.term);
    this.setOptionAsAlt();
    e.ghostty_key_event_set_action(this.keyEvent, spec.action);
    e.ghostty_key_event_set_key(this.keyEvent, spec.key);
    e.ghostty_key_event_set_mods(this.keyEvent, spec.mods);
    e.ghostty_key_event_set_consumed_mods(this.keyEvent, spec.consumedMods);
    e.ghostty_key_event_set_composing(this.keyEvent, 0);
    e.ghostty_key_event_set_unshifted_codepoint(this.keyEvent, spec.unshifted);
    const utf8 = UTF8.encode(spec.utf8);
    const utf8Ptr = utf8.length > 0 ? this.abi.writeInto(utf8) : 0;
    e.ghostty_key_event_set_utf8(this.keyEvent, utf8Ptr, utf8.length);
    try {
      const out = this.encodeWithRetry("encodeKey", KEY_BUF_LEN, (buf, len, outPtr) =>
        e.ghostty_key_encoder_encode(this.keyEncoder, this.keyEvent, buf, len, outPtr),
      );
      return out.length === 0 ? null : out;
    } finally {
      // The event borrows the utf8 buffer; drop the borrow before the memory goes away.
      e.ghostty_key_event_set_utf8(this.keyEvent, 0, 0);
      if (utf8Ptr !== 0) {
        this.abi.free(utf8Ptr, utf8.length);
      }
    }
  }

  /** Whether a DEC private mode is currently enabled. */
  private modeEnabled(mode: number): boolean {
    this.requireOpen();
    // GhosttyTerminalModeConfig (frozen layout): u16 mode, then a bool the query fills in.
    const ptr = this.abi.alloc(MODE_CONFIG_SIZE);
    try {
      this.abi.writeU16(ptr, mode);
      const rc = this.e.ghostty_terminal_get(this.term, DATA_MODE, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: mode ${mode} query failed (rc=${rc})`);
      }
      return this.abi.readU8(ptr + MODE_CONFIG_VALUE_OFFSET) !== 0;
    } finally {
      this.abi.free(ptr, MODE_CONFIG_SIZE);
    }
  }

  /** Whether the application enabled bracketed paste (mode 2004) — vim, zsh, claude-code do. */
  bracketedPaste(): boolean {
    return this.modeEnabled(MODE_BRACKETED_PASTE);
  }

  /** Whether the application asked for focus reports (mode 1004). */
  focusReporting(): boolean {
    return this.modeEnabled(MODE_FOCUS_REPORTING);
  }

  /** Whether the application is mid-redraw under synchronized output (mode 2026). */
  synchronizedOutput(): boolean {
    return this.modeEnabled(MODE_SYNCHRONIZED_OUTPUT);
  }

  /** Whether the application asked to hear about the mouse (modes 9/1000/1002/1003). */
  mouseTracking(): boolean {
    return MODES_MOUSE_TRACKING.some((mode) => this.modeEnabled(mode));
  }

  /**
   * Encodes a mouse event the way the application asked for it — tracking mode (which events),
   * report format (X10, UTF-8, SGR, urxvt, SGR-pixels) — through libghostty's mouse encoder synced
   * with the terminal's live modes. Null when the event is not reported: tracking off, or motion
   * the mode does not carry. Every motion event is reported; the caller collapses repeats within
   * one cell.
   */
  encodeMouse(spec: MouseEventSpec): Uint8Array | null {
    this.requireOpen();
    const e = this.e;
    e.ghostty_mouse_encoder_setopt_from_terminal(this.mouseEncoder, this.term);
    this.setMouseGeometry();
    this.setMouseBool(
      MOUSE_OPT_ANY_BUTTON_PRESSED,
      spec.button !== undefined && spec.action !== "release",
    );
    e.ghostty_mouse_event_set_action(this.mouseEvent, MOUSE_ACTIONS[spec.action]);
    if (spec.button === undefined) {
      e.ghostty_mouse_event_clear_button(this.mouseEvent);
    } else {
      e.ghostty_mouse_event_set_button(this.mouseEvent, MOUSE_BUTTONS[spec.button]);
    }
    e.ghostty_mouse_event_set_mods(this.mouseEvent, spec.mods);
    const { w, h } = this.mouseCell();
    const position = this.abi.alloc(MOUSE_POSITION_STRUCT);
    try {
      const dv = new DataView(e.memory.buffer);
      dv.setFloat32(position, (spec.x + 0.5) * w, true);
      dv.setFloat32(position + 4, (spec.y + 0.5) * h, true);
      e.ghostty_mouse_event_set_position(this.mouseEvent, position);
    } finally {
      this.abi.free(position, MOUSE_POSITION_STRUCT);
    }
    const out = this.encodeWithRetry("encodeMouse", MOUSE_BUF_LEN, (buf, len, outPtr) =>
      e.ghostty_mouse_encoder_encode(this.mouseEncoder, this.mouseEvent, buf, len, outPtr),
    );
    return out.length === 0 ? null : out;
  }

  /** The cell size the mouse encoder works in: real pixels when known, else unit cells. */
  private mouseCell(): { w: number; h: number } {
    return this.cellPx.w > 0 && this.cellPx.h > 0 ? this.cellPx : { w: 1, h: 1 };
  }

  private setMouseGeometry(): void {
    const { w, h } = this.mouseCell();
    const ptr = this.abi.alloc(MOUSE_SIZE_STRUCT);
    try {
      this.abi.bytes().fill(0, ptr, ptr + MOUSE_SIZE_STRUCT);
      this.abi.writeU32(ptr, MOUSE_SIZE_STRUCT);
      this.abi.writeU32(ptr + 4, this.cols * w);
      this.abi.writeU32(ptr + 8, this.rows * h);
      this.abi.writeU32(ptr + 12, w);
      this.abi.writeU32(ptr + 16, h);
      this.e.ghostty_mouse_encoder_setopt(this.mouseEncoder, MOUSE_OPT_SIZE, ptr);
    } finally {
      this.abi.free(ptr, MOUSE_SIZE_STRUCT);
    }
  }

  /** The CSI I / CSI O focus report — send only when {@link focusReporting} says the app wants it. */
  encodeFocus(focused: boolean): Uint8Array {
    this.requireOpen();
    return this.encodeWithRetry("encodeFocus", 8, (buf, len, out) =>
      this.e.ghostty_focus_encode(focused ? FOCUS_GAINED : FOCUS_LOST, buf, len, out),
    );
  }

  /**
   * Full reset to a blank ground state — screen, scrollback, and every mode. The baseline for a
   * mid-stream journal replay: the incoming snapshot must land on a clean terminal, not on top of
   * whatever a dropped-bytes gap left behind.
   */
  reset(): void {
    this.requireOpen();
    this.e.ghostty_terminal_reset(this.term);
  }

  /** Whether the application is on the alternate screen (a full-screen TUI, no scrollback). */
  altScreen(): boolean {
    return MODES_ALT_SCREEN.some((mode) => this.modeEnabled(mode));
  }

  /**
   * Encodes pasted text into the bytes the pty should receive, per the terminal's current state:
   * wrapped in bracketed-paste markers when the app enabled mode 2004, newlines converted to
   * carriage returns when it didn't, and raw ESC/control bytes stripped either way so pasted text
   * can never forge sequences (libghostty's own paste encoder).
   */
  encodePaste(text: string): Uint8Array {
    this.requireOpen();
    const data = UTF8.encode(text);
    if (data.length === 0) {
      return data;
    }
    const bracketed = this.bracketedPaste();
    // Bracketed framing adds 12 bytes; stripping never grows the text, so the retry never fires.
    // The input is re-written per attempt because the encoder strips it in place.
    return this.encodeWithRetry("encodePaste", data.length + PASTE_FRAME_OVERHEAD, (buf, len, out) => {
      const dataPtr = this.abi.writeInto(data);
      try {
        return this.e.ghostty_paste_encode(dataPtr, data.length, bracketed ? 1 : 0, buf, len, out);
      } finally {
        this.abi.free(dataPtr, data.length);
      }
    });
  }

  /**
   * Runs an encode call that reports its required size on OUT_OF_SPACE, retrying once with that
   * size. A second refusal — or a "required" size that doesn't exceed the buffer offered — is a
   * broken wasm contract and throws rather than looping.
   */
  private encodeWithRetry(
    what: string,
    initialLen: number,
    call: (bufPtr: number, bufLen: number, outPtr: number) => number,
  ): Uint8Array {
    let need = initialLen;
    for (let attempt = 0; attempt < 2; attempt++) {
      const bufLen = need;
      const bufPtr = this.abi.alloc(bufLen);
      const outPtr = this.abi.alloc(4);
      try {
        const rc = call(bufPtr, bufLen, outPtr);
        const written = this.abi.readU32(outPtr);
        if (rc === SUCCESS) {
          return this.abi.bytes().slice(bufPtr, bufPtr + written);
        }
        if (rc !== OUT_OF_SPACE || written <= bufLen) {
          throw new Error(`VtCore.${what} failed (rc=${rc}, need=${written})`);
        }
        need = written;
      } finally {
        this.abi.free(outPtr, 4);
        this.abi.free(bufPtr, bufLen);
      }
    }
    throw new Error(`VtCore.${what}: the encoder rejected its own required size`);
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

  /** The cursor's viewport position, DECSCUSR shape, blink request, and visibility. */
  cursor(): Cursor {
    this.requireOpen();
    this.refresh();
    const present = this.getBool(RS_DATA_CURSOR_VIEWPORT_HAS_VALUE);
    if (!present) {
      return { present: false, x: 0, y: 0, visible: false, style: "block", blinking: false };
    }
    const style = CURSOR_STYLES[this.getU32(RS_DATA_CURSOR_VISUAL_STYLE)];
    if (style === undefined) {
      throw new Error("VtCore: libghostty reported an unknown cursor style");
    }
    return {
      present: true,
      x: this.getU16(RS_DATA_CURSOR_VIEWPORT_X),
      y: this.getU16(RS_DATA_CURSOR_VIEWPORT_Y),
      visible: this.getBool(RS_DATA_CURSOR_VISIBLE),
      style,
      blinking: this.getBool(RS_DATA_CURSOR_BLINKING),
    };
  }

  /**
   * Moves the viewport through scrollback. A later {@link readAll} reflects the new position; the
   * cursor reports absent while scrolled off the active area, so the caller draws none. Writing new
   * output does not move the viewport, so a scrolled-up view stays put until scrolled back to bottom.
   */
  scroll(behavior: Scroll): void {
    this.requireOpen();
    const ptr = this.abi.alloc(SCROLL_STRUCT_SIZE);
    try {
      const bytes = this.abi.bytes();
      for (let i = 0; i < SCROLL_STRUCT_SIZE; i++) bytes[ptr + i] = 0;
      const dv = new DataView(this.e.memory.buffer);
      if (behavior === "top") {
        dv.setUint32(ptr, SCROLL_TOP, true);
      } else if (behavior === "bottom") {
        dv.setUint32(ptr, SCROLL_BOTTOM, true);
      } else {
        dv.setUint32(ptr, SCROLL_DELTA, true);
        dv.setInt32(ptr + 8, behavior.delta, true);
      }
      this.e.ghostty_terminal_scroll_viewport(this.term, ptr);
    } finally {
      this.abi.free(ptr, SCROLL_STRUCT_SIZE);
    }
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
    this.abi.free(this.identityPtr, this.identityLen);
    this.abi.free(this.optAsAltPtr, 4);
    this.e.ghostty_selection_gesture_event_free(this.releaseEvent);
    this.e.ghostty_selection_gesture_event_free(this.dragEvent);
    this.e.ghostty_selection_gesture_event_free(this.pressEvent);
    this.e.ghostty_selection_gesture_free(this.gesture, this.term);
    this.e.ghostty_mouse_event_free(this.mouseEvent);
    this.e.ghostty_mouse_encoder_free(this.mouseEncoder);
    this.e.ghostty_key_event_free(this.keyEvent);
    this.e.ghostty_key_encoder_free(this.keyEncoder);
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
    const widthPtr = this.abi.alloc(1);
    const stylePtr = this.abi.alloc(STYLE_SIZE);
    try {
      while (this.e.ghostty_render_state_row_cells_next(this.cells)) {
        const style = this.readStyle(fgPtr, stylePtr);
        const fg = this.readColor(CELLS_DATA_FG_COLOR, fgPtr);
        const bg = this.readColor(CELLS_DATA_BG_COLOR, bgPtr);
        const { text, width } = this.readGrapheme(lenPtr, widthPtr);
        const selected = this.readFlag(CELLS_DATA_SELECTED, widthPtr);
        cells.push({
          text,
          width,
          selected,
          fg: style.inverse ? bg : fg,
          bg: style.inverse ? fg : bg,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
          underlineColor: style.underlineColor,
          strikethrough: style.strikethrough,
          overline: style.overline,
          faint: style.faint,
          invisible: style.invisible,
        });
      }
    } finally {
      this.abi.free(lenPtr, 4);
      this.abi.free(fgPtr, 4);
      this.abi.free(bgPtr, 4);
      this.abi.free(widthPtr, 1);
      this.abi.free(stylePtr, STYLE_SIZE);
    }
    return cells;
  }

  /** A per-cell bool of the current cell; {@code scratch} is a reusable 1-byte buffer. */
  private readFlag(kind: number, scratch: number): boolean {
    const rc = this.e.ghostty_render_state_row_cells_get(this.cells, kind, scratch);
    if (rc !== SUCCESS) {
      throw new Error(`VtCore: reading cell flag ${kind} failed (rc=${rc})`);
    }
    return this.abi.readU8(scratch) !== 0;
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
    const underline = UNDERLINE_STYLES[dv.getInt32(stylePtr + STYLE_UNDERLINE, true)];
    if (underline === undefined) {
      throw new Error("VtCore: libghostty reported an unknown underline style");
    }
    return {
      bold: m[stylePtr + STYLE_BOLD] !== 0,
      italic: m[stylePtr + STYLE_ITALIC] !== 0,
      faint: m[stylePtr + STYLE_FAINT] !== 0,
      inverse: m[stylePtr + STYLE_INVERSE] !== 0,
      invisible: m[stylePtr + STYLE_INVISIBLE] !== 0,
      strikethrough: m[stylePtr + STYLE_STRIKETHROUGH] !== 0,
      overline: m[stylePtr + STYLE_OVERLINE] !== 0,
      underline,
      underlineColor: this.readStyleColor(stylePtr + STYLE_UNDERLINE_COLOR_TAG),
    };
  }

  /**
   * A GhosttyStyleColor tagged union: unset, a palette index (resolved through the terminal's live
   * palette, so OSC 4 redefinitions apply), or a true-color triple.
   */
  private readStyleColor(ptr: number): Rgb | null {
    const tag = this.abi.readU32(ptr);
    const value = ptr + (STYLE_UNDERLINE_COLOR_VALUE - STYLE_UNDERLINE_COLOR_TAG);
    if (tag === STYLE_COLOR_RGB) {
      return this.abi.readRgb(value);
    }
    if (tag === STYLE_COLOR_PALETTE) {
      return this.paletteColor(this.abi.readU8(value));
    }
    return null;
  }

  private paletteColor(index: number): Rgb {
    const ptr = this.abi.alloc(PALETTE_BYTES);
    try {
      const rc = this.e.ghostty_render_state_get(this.state, RS_DATA_COLOR_PALETTE, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading the palette failed (rc=${rc})`);
      }
      return this.abi.readRgb(ptr + index * 3);
    } finally {
      this.abi.free(ptr, PALETTE_BYTES);
    }
  }

  /** The cell's grapheme text and its display width (2 for wide CJK/emoji, else 1). Blank cells are
   *  width 1 so the column after a wide glyph — its spacer — never claims extra width itself. */
  private readGrapheme(lenPtr: number, widthPtr: number): { text: string; width: number } {
    if (
      this.e.ghostty_render_state_row_cells_get(this.cells, CELLS_DATA_GRAPHEMES_LEN, lenPtr) !==
      SUCCESS
    ) {
      return { text: "", width: 1 };
    }
    const count = this.abi.readU32(lenPtr);
    if (count === 0) {
      return { text: "", width: 1 };
    }
    const buf = this.abi.alloc(count * 4);
    try {
      if (
        this.e.ghostty_render_state_row_cells_get(this.cells, CELLS_DATA_GRAPHEMES_BUF, buf) !==
        SUCCESS
      ) {
        return { text: "", width: 1 };
      }
      this.e.ghostty_unicode_grapheme_width(buf, count, widthPtr);
      const width = this.abi.readU8(widthPtr) === 2 ? 2 : 1;
      let text = "";
      for (let i = 0; i < count; i++) {
        text += String.fromCodePoint(this.abi.readU32(buf + i * 4));
      }
      return { text, width };
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

  private getU32(data: number): number {
    const ptr = this.abi.alloc(4);
    try {
      const rc = this.e.ghostty_render_state_get(this.state, data, ptr);
      if (rc !== SUCCESS) {
        throw new Error(`VtCore: reading scalar ${data} failed (rc=${rc})`);
      }
      return this.abi.readU32(ptr);
    } finally {
      this.abi.free(ptr, 4);
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
