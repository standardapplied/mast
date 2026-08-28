/**
 * Keyboard → PTY byte encoding, xterm-style. A pure function of a {@link KeyStroke} (the DOM-free
 * subset of a KeyboardEvent the widget forwards), so it is exhaustively testable without a browser.
 * Returns the bytes to send to the pty, or {@code null} when the key produces nothing to send (a
 * bare modifier, an unhandled key) — the caller then lets the browser handle it.
 *
 * There is no local echo here: a terminal shows what the pty sends back, never the keystroke itself.
 */

/** The DOM-free shape of a key press: `key` is the KeyboardEvent.key value, plus the modifiers. */
export interface KeyStroke {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

const ESC = "\x1b";

/** Named keys that map to a fixed sequence, independent of modifiers (before CSI-modifier work). */
const NAMED: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Backspace: "\x7f",
  Escape: ESC,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  Insert: `${ESC}[2~`,
  Delete: `${ESC}[3~`,
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
};

/** Modifier keys pressed on their own send nothing. */
const BARE_MODIFIER = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"]);

const encoder = new TextEncoder();

/** Encodes one key press to the bytes the pty expects, or {@code null} when nothing should be sent. */
export function encodeKey(stroke: KeyStroke): Uint8Array | null {
  const { key, ctrl = false, alt = false, meta = false } = stroke;

  // Cmd chords are the app's and the OS's (copy, paste, app shortcuts) — never pty bytes.
  if (meta || BARE_MODIFIER.has(key)) {
    return null;
  }

  // Ctrl+key control codes (Ctrl+A..Z → 0x01..0x1a, plus the classic symbol controls).
  if (ctrl && !alt) {
    const control = controlByte(key);
    if (control !== null) {
      return Uint8Array.of(control);
    }
  }

  const named = NAMED[key];
  if (named !== undefined) {
    // Alt on a named key prefixes ESC (xterm meta-sends-escape).
    return encoder.encode(alt ? ESC + named : named);
  }

  // A single printable character.
  if (charLength(key) === 1) {
    return encoder.encode(alt ? ESC + key : key);
  }

  return null;
}

/** The control byte for Ctrl+{@code key}, or null when the key has no control mapping. */
function controlByte(key: string): number | null {
  if (key.length === 1) {
    const code = key.codePointAt(0)!;
    const upper = code >= 0x61 && code <= 0x7a ? code - 0x20 : code; // a→A
    if (upper >= 0x40 && upper <= 0x5f) {
      // @ A..Z [ \ ] ^ _  →  0x00..0x1f
      return upper & 0x1f;
    }
    if (key === " ") {
      return 0x00; // Ctrl+Space → NUL
    }
    if (key === "?") {
      return 0x7f; // Ctrl+? → DEL
    }
  }
  return null;
}

/** The code-point length of a string (so an emoji or accented grapheme counts as one). */
function charLength(s: string): number {
  return [...s].length;
}
