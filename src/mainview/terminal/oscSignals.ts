/**
 * OSC side-signal detection over the raw pty stream — the sequences a terminal must ACT on rather
 * than draw. Two families matter here:
 *
 * - **OSC 52** (clipboard write): TUIs (claude-code's "press c to copy", tmux, neovim) set the
 *   system clipboard through the terminal. Queries (`?`) are deliberately ignored — answering one
 *   would leak clipboard contents to whatever runs in the shell.
 * - **OSC 0/2** (window/icon title): every stock Ubuntu bash PS1 emits these; they are the shell's
 *   own name for itself (`user@host: dir`) and feed the pane's default title.
 *
 * The scanner is a byte-level state machine fed the same chunks the VT core gets (it never
 * consumes them — libghostty parses the OSCs itself), stateful across arbitrary chunk boundaries.
 * Every OSC is parsed by its numeric code, so payload bytes of an unrelated OSC can never
 * false-match: unknown codes are skipped to their terminator.
 */

const ESC = 0x1b;
const OSC_OPEN = 0x5d;
const BEL = 0x07;
const ST_BACKSLASH = 0x5c;
const SEMI = 0x3b;

/** Payloads past this size are abandoned — a garbled stream must not buffer unboundedly. */
const MAX_PAYLOAD = 128 * 1024;
const MAX_CODE_DIGITS = 4;

export type OscSignal =
  | { readonly kind: "clipboard"; readonly text: string }
  | { readonly kind: "title"; readonly text: string };

type State =
  | { at: "idle" }
  | { at: "esc" }
  | { at: "code"; digits: string }
  | { at: "payload"; code: number | null; bytes: number[]; esc: boolean };

const IDLE: State = { at: "idle" };
const ESC_SEEN: State = { at: "esc" };

export class OscSignalScanner {
  private state: State = IDLE;

  /** Forgets any half-captured sequence — call when the stream itself restarts (a replay). */
  reset(): void {
    this.state = IDLE;
  }

  /** Scans one pty chunk; returns any complete signals it finished, in stream order. */
  feed(bytes: Uint8Array): OscSignal[] {
    const found: OscSignal[] = [];
    for (const byte of bytes) {
      const s = this.state;
      switch (s.at) {
        case "idle":
          if (byte === ESC) this.state = ESC_SEEN;
          break;
        case "esc":
          this.state = byte === OSC_OPEN ? { at: "code", digits: "" } : byte === ESC ? s : IDLE;
          break;
        case "code":
          if (byte >= 0x30 && byte <= 0x39 && s.digits.length < MAX_CODE_DIGITS) {
            s.digits += String.fromCharCode(byte);
          } else if (byte === SEMI && s.digits.length > 0) {
            const code = Number(s.digits);
            this.state = {
              at: "payload",
              code: code === 52 || code === 0 || code === 2 ? code : null,
              bytes: [],
              esc: false,
            };
          } else if (byte === ESC) {
            this.state = ESC_SEEN;
          } else {
            this.state = IDLE;
          }
          break;
        case "payload":
          if (s.esc) {
            // The aborting ESC may itself open the next sequence: ESC + ']' is a fresh OSC.
            if (byte === ST_BACKSLASH) this.finish(s, found);
            else if (byte === OSC_OPEN) this.state = { at: "code", digits: "" };
            else this.state = byte === ESC ? ESC_SEEN : IDLE;
          } else if (byte === BEL) {
            this.finish(s, found);
          } else if (byte === ESC) {
            s.esc = true;
          } else if (s.code !== null && s.bytes.length < MAX_PAYLOAD) {
            s.bytes.push(byte);
          } else if (s.bytes.length >= MAX_PAYLOAD) {
            s.code = null;
            s.bytes = [];
          }
          break;
      }
    }
    return found;
  }

  private finish(s: { code: number | null; bytes: number[] }, found: OscSignal[]): void {
    this.state = IDLE;
    if (s.code === null) return;
    if (s.code === 52) {
      const text = decodeClipboard(s.bytes);
      if (text !== null) found.push({ kind: "clipboard", text });
    } else {
      found.push({ kind: "title", text: decodeUtf8(s.bytes) });
    }
  }
}

/** OSC 52 payload is `<targets>;<base64>`; `?` is a read query, never honored. */
function decodeClipboard(payload: number[]): string | null {
  const semi = payload.indexOf(SEMI);
  if (semi < 0) return null;
  const data = payload.slice(semi + 1);
  if (data.length === 1 && data[0] === 0x3f) return null;
  try {
    let b64text = "";
    for (let i = 0; i < data.length; i += 4096) {
      b64text += String.fromCharCode(...data.slice(i, i + 4096));
    }
    const raw = atob(b64text);
    const utf8 = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(utf8);
  } catch {
    return null;
  }
}

function decodeUtf8(payload: number[]): string {
  return new TextDecoder().decode(Uint8Array.from(payload));
}
