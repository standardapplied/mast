/**
 * Kitty-keyboard-protocol bridge for ghostty-web 0.4, which neither answers
 * the protocol's terminal queries nor feeds pushed flags to its key encoder —
 * so kitty-aware TUIs (Claude Code, Codex) probe `CSI ? u`, hear silence, and
 * fall back to legacy keys where Shift+Enter is indistinguishable from Enter.
 *
 * The bridge observes the PTY output stream for the protocol's `CSI … u`
 * sequences: it answers the query with the active flags, tracks push/pop/set,
 * and clears on a full reset (RIS). TerminalPane consults `flags` through
 * shiftEnterSequence to pick the encoding for Shift+Enter.
 *
 * One flag stack is kept, not the spec's two (main + alternate screen): the
 * TUIs we care about push and pop symmetrically around their lifetime, and a
 * missed pop is exactly as stale as it would be in a real terminal.
 */

const SEQUENCE = /\x1b(?:\[([?<>=])([0-9;]*)u|c)/g;
const MAX_PENDING = 16;
const MAX_STACK = 8;
const BYTES = new TextDecoder("latin1");

export const KITTY_DISAMBIGUATE = 1;

/**
 * The bytes Shift+Enter should send. With kitty disambiguation active, the
 * protocol's own encoding. Without it, ESC CR — Claude Code parses that as
 * meta+return → insert newline UNCONDITIONALLY (verified against the 2.1.206
 * binary), and bash treats it as an unbound no-op — so even a failed TERM
 * negotiation can never make Shift+Enter submit a prompt again.
 */
export function shiftEnterSequence(flags: number): string {
  return flags & KITTY_DISAMBIGUATE ? "\x1b[13;2u" : "\x1b\r";
}

export class KittyKeyboardBridge {
  private stack: number[] = [];
  private pending = "";

  /** Active flags — 0 until the app pushes some. */
  get flags(): number {
    return this.stack[this.stack.length - 1] ?? 0;
  }

  /**
   * Scan a PTY output chunk (pass the chunk to the terminal unchanged) and
   * return any protocol replies to write back to the PTY, "" for none.
   */
  feed(chunk: Uint8Array): string {
    const text = this.pending + BYTES.decode(chunk);

    let reply = "";
    let consumed = 0;
    SEQUENCE.lastIndex = 0;
    for (let m = SEQUENCE.exec(text); m; m = SEQUENCE.exec(text)) {
      consumed = SEQUENCE.lastIndex;
      if (m[1] === undefined) {
        this.stack = [];
        continue;
      }
      const param = m[2] ?? "";
      if (m[1] === "?" && param === "") reply += `\x1b[?${this.flags}u`;
      else if (m[1] === ">") this.push(Number(param || "0"));
      else if (m[1] === "<") this.pop(Number(param || "1"));
      else if (m[1] === "=") this.set(param);
    }

    this.pending = trailingPrefix(text.slice(consumed));
    return reply;
  }

  private push(flags: number): void {
    if (this.stack.length >= MAX_STACK) this.stack.shift();
    this.stack.push(flags);
  }

  private pop(n: number): void {
    this.stack.length = Math.max(0, this.stack.length - n);
  }

  private set(param: string): void {
    const [flags = 0, mode = 1] = param.split(";").map((p) => Number(p || "0"));
    if (this.stack.length === 0) this.stack.push(0);
    const top = this.stack.length - 1;
    if (mode === 1) this.stack[top] = flags;
    else if (mode === 2) this.stack[top]! |= flags;
    else if (mode === 3) this.stack[top]! &= ~flags;
  }
}

/**
 * The shortest tail of `text` that could still be the start of a sequence the
 * bridge cares about, kept for the next chunk — escape sequences routinely
 * split across PTY reads. Bounded so binary output can't grow it.
 */
function trailingPrefix(text: string): string {
  const esc = text.lastIndexOf("\x1b");
  if (esc === -1) return "";
  const tail = text.slice(esc);
  if (tail.length > MAX_PENDING) return "";
  return /^\x1b(?:\[[?<>=]?[0-9;]*)?$/.test(tail) ? tail : "";
}
