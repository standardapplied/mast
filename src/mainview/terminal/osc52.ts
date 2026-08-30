/**
 * OSC 52 clipboard-write detection over the raw pty stream. TUIs (claude-code's "press c to copy",
 * tmux, neovim) set the system clipboard by emitting `ESC ] 52 ; <targets> ; <base64> BEL|ST` —
 * the terminal is the clipboard bridge, and a terminal that drops these silently breaks copy.
 *
 * The scanner is a byte-level state machine fed the same chunks the VT core gets (it never
 * consumes them — libghostty parses and ignores the OSC itself), stateful across arbitrary chunk
 * boundaries. Queries (`?`, a request to READ the clipboard) are deliberately ignored: answering
 * one would leak clipboard contents to whatever runs in the shell.
 */

const PREFIX = new TextEncoder().encode("\x1b]52;");
const ESC = 0x1b;
const BEL = 0x07;
const ST_BACKSLASH = 0x5c;

/** Payloads past this size are abandoned — a garbled stream must not buffer unboundedly. */
const MAX_PAYLOAD = 128 * 1024;

type State = { at: "prefix"; matched: number } | { at: "payload"; bytes: number[]; esc: boolean };

export class Osc52Scanner {
  private state: State = { at: "prefix", matched: 0 };

  /** Forgets any half-captured sequence — call when the stream itself restarts (a replay). */
  reset(): void {
    this.state = { at: "prefix", matched: 0 };
  }

  /** Scans one pty chunk; returns any complete clipboard writes it finished, decoded. */
  feed(bytes: Uint8Array): string[] {
    const found: string[] = [];
    for (const byte of bytes) {
      if (this.state.at === "prefix") {
        if (byte === PREFIX[this.state.matched]) {
          this.state.matched++;
          if (this.state.matched === PREFIX.length) {
            this.state = { at: "payload", bytes: [], esc: false };
          }
        } else {
          // A failed match may itself start a new prefix (e.g. ESC after partial junk).
          this.state.matched = byte === PREFIX[0] ? 1 : 0;
        }
        continue;
      }
      if (this.state.esc) {
        if (byte === ST_BACKSLASH) {
          this.finish(found);
        } else {
          // The aborting ESC may itself open the NEXT sequence: ESC + ']' is two prefix bytes in.
          this.state = {
            at: "prefix",
            matched: byte === ESC ? 1 : byte === PREFIX[1] ? 2 : 0,
          };
        }
        continue;
      }
      if (byte === BEL) {
        this.finish(found);
      } else if (byte === ESC) {
        this.state.esc = true;
      } else if (this.state.bytes.length >= MAX_PAYLOAD) {
        this.state = { at: "prefix", matched: 0 };
      } else {
        this.state.bytes.push(byte);
      }
    }
    return found;
  }

  private finish(found: string[]): void {
    const payload = this.state.at === "payload" ? this.state.bytes : [];
    this.state = { at: "prefix", matched: 0 };
    const semi = payload.indexOf(0x3b);
    if (semi < 0) return;
    const data = payload.slice(semi + 1);
    if (data.length === 1 && data[0] === 0x3f) return;
    try {
      // Chunked: spreading 100K+ args into fromCharCode trips engine argument limits (~64K in JSC).
      let b64text = "";
      for (let i = 0; i < data.length; i += 4096) {
        b64text += String.fromCharCode(...data.slice(i, i + 4096));
      }
      const raw = atob(b64text);
      const utf8 = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
      found.push(new TextDecoder("utf-8", { fatal: true }).decode(utf8));
    } catch {
      /* not valid base64/UTF-8 — not a clipboard write we can honor */
    }
  }
}
