/**
 * Keyboard → libghostty key-event translation. Pure functions of a {@link KeyStroke} (the DOM-free
 * subset of a KeyboardEvent the widget forwards); the actual byte encoding is libghostty's key
 * encoder, driven through {@link VtCore#encodeKey} with the terminal's own modes (cursor-key
 * application, kitty keyboard protocol, modifyOtherKeys) — the hand-rolled xterm table this file
 * used to hold could not honor any of those.
 *
 * {@link GHOSTTY_KEY} mirrors the `GhosttyKey` C enum's declaration order EXACTLY (vt/key/event.h
 * at the pinned wasm, see PIN.md): the index *is* the ABI value. The names are the W3C UI Events
 * `KeyboardEvent.code` strings the enum is defined from, so a DOM `code` maps by lookup. On a wasm
 * re-pin, the anchored-ordinal test plus the wasm-driven encoder tests fail loudly if this drifts.
 */

/** The DOM-free shape of a key press: `key`/`code` are the KeyboardEvent values, plus modifiers. */
export interface KeyStroke {
  readonly key: string;
  readonly code?: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly caps?: boolean;
  readonly repeat?: boolean;
  readonly composing?: boolean;
}

/** A key event in libghostty's terms, ready for {@link VtCore#encodeKey}. */
export interface KeyEventSpec {
  readonly key: number;
  readonly mods: number;
  readonly consumedMods: number;
  readonly utf8: string;
  readonly unshifted: number;
  readonly action: number;
  readonly composing: boolean;
}

/** GhosttyMods bits. */
export const MODS = { SHIFT: 1, CTRL: 2, ALT: 4, SUPER: 8, CAPS: 16, NUM: 32 } as const;

/** GhosttyKeyAction values. */
export const ACTION = { RELEASE: 0, PRESS: 1, REPEAT: 2 } as const;

/* eslint-disable prettier/prettier */
/** The `GhosttyKey` enum in declaration order — index = ABI value. Do not sort, ever. */
export const GHOSTTY_KEY: readonly string[] = [
  "Unidentified",
  // Writing System Keys (W3C § 3.1.1)
  "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "Equal", "IntlBackslash", "IntlRo", "IntlYen",
  "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL",
  "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX",
  "KeyY", "KeyZ",
  "Minus", "Period", "Quote", "Semicolon", "Slash",
  // Functional Keys (W3C § 3.1.2)
  "AltLeft", "AltRight", "Backspace", "CapsLock", "ContextMenu", "ControlLeft", "ControlRight",
  "Enter", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight", "Space", "Tab",
  "Convert", "KanaMode", "NonConvert",
  // Control Pad Section (W3C § 3.2)
  "Delete", "End", "Help", "Home", "Insert", "PageDown", "PageUp",
  // Arrow Pad Section (W3C § 3.3)
  "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
  // Numpad Section (W3C § 3.4)
  "NumLock",
  "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7",
  "Numpad8", "Numpad9",
  "NumpadAdd", "NumpadBackspace", "NumpadClear", "NumpadClearEntry", "NumpadComma",
  "NumpadDecimal", "NumpadDivide", "NumpadEnter", "NumpadEqual",
  "NumpadMemoryAdd", "NumpadMemoryClear", "NumpadMemoryRecall", "NumpadMemoryStore",
  "NumpadMemorySubtract", "NumpadMultiply", "NumpadParenLeft", "NumpadParenRight",
  "NumpadSubtract", "NumpadSeparator",
  "NumpadUp", "NumpadDown", "NumpadRight", "NumpadLeft", "NumpadBegin", "NumpadHome",
  "NumpadEnd", "NumpadInsert", "NumpadDelete", "NumpadPageUp", "NumpadPageDown",
  // Function Section (W3C § 3.5)
  "Escape",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13",
  "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24", "F25",
  "Fn", "FnLock", "PrintScreen", "ScrollLock", "Pause",
  // Media Keys (W3C § 3.6) and the rest
  "BrowserBack", "BrowserFavorites", "BrowserForward", "BrowserHome", "BrowserRefresh",
  "BrowserSearch", "BrowserStop", "Eject", "LaunchApp1", "LaunchApp2", "LaunchMail",
  "MediaPlayPause", "MediaSelect", "MediaStop", "MediaTrackNext", "MediaTrackPrevious",
  "Power", "Sleep", "AudioVolumeDown", "AudioVolumeMute", "AudioVolumeUp", "WakeUp",
  "Copy", "Cut", "Paste",
];
/* eslint-enable prettier/prettier */

const KEY_INDEX = new Map(GHOSTTY_KEY.map((code, i) => [code, i]));

/** DOM `key` values that equal their W3C `code` name, for events arriving without a code. */
const KEY_EQUALS_CODE = new Set([
  "Enter", "Tab", "Backspace", "Escape", "Home", "End", "Insert", "Delete",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ...Array.from({ length: 25 }, (_, i) => `F${i + 1}`),
]);

/** The character a physical key produces with no modifiers (US layout), for `unshifted`. */
const BASE_CHAR: Record<string, string> = {
  Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Comma: ",",
  Equal: "=", Minus: "-", Period: ".", Quote: "'", Semicolon: ";", Slash: "/", Space: " ",
};

/**
 * The libghostty key value for a DOM code, or 0 (Unidentified). An absent OR empty code (synthetic
 * events, soft keyboards) falls back to deriving from the key, so named keys never go dark there.
 */
export function ghosttyKeyOf(code: string | undefined, key: string): number {
  if (code) {
    return KEY_INDEX.get(code) ?? 0;
  }
  if (key.length === 1) {
    if (key >= "a" && key <= "z") return KEY_INDEX.get(`Key${key.toUpperCase()}`)!;
    if (key >= "A" && key <= "Z") return KEY_INDEX.get(`Key${key}`)!;
    if (key >= "0" && key <= "9") return KEY_INDEX.get(`Digit${key}`)!;
    if (key === " ") return KEY_INDEX.get("Space")!;
  }
  return KEY_EQUALS_CODE.has(key) ? KEY_INDEX.get(key)! : 0;
}

/** The code-point length of a string (so an emoji or accented grapheme counts as one). */
function charLength(s: string): number {
  return [...s].length;
}

/**
 * The unmodified codepoint of the pressed key. The active LAYOUT wins for letters and digits —
 * QWERTZ Ctrl+Z arrives on physical KeyY but must byte as 'z', and a Cyrillic 'ф' carries its own
 * codepoint — while shifted punctuation falls back to the physical key's base char (Shift+2
 * produces '@' but the key without shift is '2', which the produced char cannot reveal).
 */
function unshiftedOf(code: string | undefined, key: string): number {
  if (charLength(key) === 1 && /[\p{L}\p{N}]/u.test(key)) {
    return key.toLowerCase().codePointAt(0)!;
  }
  if (code) {
    if (code.startsWith("Key") && code.length === 4) return code.toLowerCase().codePointAt(3)!;
    if (code.startsWith("Digit") && code.length === 6) return code.codePointAt(5)!;
    const base = BASE_CHAR[code];
    if (base !== undefined) return base.codePointAt(0)!;
  }
  return charLength(key) === 1 ? key.toLowerCase().codePointAt(0)! : 0;
}

/** Translates one DOM key press into the event libghostty's encoder consumes. */
export function keyEventFor(stroke: KeyStroke): KeyEventSpec {
  const { key, code, ctrl = false, alt = false, meta = false, shift = false, caps = false } = stroke;
  const mods =
    (shift ? MODS.SHIFT : 0) |
    (ctrl ? MODS.CTRL : 0) |
    (alt ? MODS.ALT : 0) |
    (meta ? MODS.SUPER : 0) |
    (caps ? MODS.CAPS : 0);
  // Every single-char key carries its text — the ENCODER decides what a chord suppresses or maps
  // (Ctrl+[ → ESC needs the '[' to reach it). Cmd chords are gated once, in the controller.
  const utf8 = charLength(key) === 1 ? key : "";
  const unshifted = unshiftedOf(code, key);
  const consumedMods =
    utf8 !== "" && shift && utf8.codePointAt(0) !== unshifted ? MODS.SHIFT : 0;
  return {
    key: ghosttyKeyOf(code, key),
    mods,
    consumedMods,
    utf8,
    unshifted,
    action: stroke.repeat ? ACTION.REPEAT : ACTION.PRESS,
    composing: stroke.composing === true || key === "Dead",
  };
}
