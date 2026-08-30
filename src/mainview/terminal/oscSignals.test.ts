import { describe, expect, test } from "bun:test";
import { OscSignalScanner } from "./oscSignals";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => btoa(s);
const clip = (text: string) => ({ kind: "clipboard", text }) as const;
const title = (text: string) => ({ kind: "title", text }) as const;

describe("OscSignalScanner — clipboard (OSC 52)", () => {
  test("a BEL-terminated clipboard write decodes to its text", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc(`\x1b]52;c;${b64("hello url")}\x07`))).toEqual([clip("hello url")]);
  });

  test("an ST-terminated write decodes too", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc(`\x1b]52;c;${b64("st-style")}\x1b\\`))).toEqual([clip("st-style")]);
  });

  test("a sequence split across arbitrary chunk boundaries still decodes", () => {
    const whole = `\x1b]52;c;${b64("split across chunks")}\x07`;
    for (let cut = 1; cut < whole.length - 1; cut++) {
      const s = new OscSignalScanner();
      const first = s.feed(enc(whole.slice(0, cut)));
      const second = s.feed(enc(whole.slice(cut)));
      expect([...first, ...second]).toEqual([clip("split across chunks")]);
    }
  });

  test("a query (?) is not a write and yields nothing", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]52;c;?\x07"))).toEqual([]);
  });

  test("unrelated OSCs are skipped by code — their payload can never false-match", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]8;;https://x.test/]52;c;QQ==\x07link\x1b]8;;\x07"))).toEqual([]);
    expect(s.feed(enc("\x1b]521;c;AAAA\x07"))).toEqual([]);
  });

  test("multiple writes in one chunk all decode, in order", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc(`\x1b]52;c;${b64("one")}\x07mid\x1b]52;p;${b64("two")}\x07`))).toEqual([
      clip("one"),
      clip("two"),
    ]);
  });

  test("invalid base64 yields nothing rather than garbage", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]52;c;!!!not-base64!!!\x07"))).toEqual([]);
  });

  test("a large payload within the cap decodes (no engine argument-limit landmine)", () => {
    const s = new OscSignalScanner();
    const text = "x".repeat(90_000);
    expect(s.feed(enc(`\x1b]52;c;${b64(text)}\x07`))).toEqual([clip(text)]);
  });

  test("a runaway payload is abandoned at the cap instead of buffering forever", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]52;c;"))).toEqual([]);
    for (let i = 0; i < 40; i++) {
      expect(s.feed(new Uint8Array(8192).fill(0x41))).toEqual([]);
    }
    expect(s.feed(enc(`\x07after\x1b]52;c;${b64("recovered")}\x07`))).toEqual([clip("recovered")]);
  });

  test("an unterminated write aborted by the next OSC does not eat that OSC", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc(`\x1b]52;c;AAAA\x1b]52;c;${b64("second")}\x07`))).toEqual([clip("second")]);
  });

  test("reset() abandons a half-captured sequence so a fresh stream parses cleanly", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]52;c;INCOMPLETE"))).toEqual([]);
    s.reset();
    expect(s.feed(enc(`\x1b]52;c;${b64("clean")}\x07`))).toEqual([clip("clean")]);
  });

  test("UTF-8 clipboard content survives the round trip", () => {
    const s = new OscSignalScanner();
    const text = "café 🚀 — ünïcode";
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(s.feed(enc(`\x1b]52;c;${payload}\x07`))).toEqual([clip(text)]);
  });
});

describe("OscSignalScanner — titles (OSC 0/2)", () => {
  test("the stock bash PS1 title escape names the shell", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]0;dev@snout: ~/workspace/mast\x07prompt$ "))).toEqual([
      title("dev@snout: ~/workspace/mast"),
    ]);
  });

  test("OSC 2 (window title) counts; icon-only OSC 1 does not", () => {
    const s = new OscSignalScanner();
    expect(s.feed(enc("\x1b]2;vim README.md\x1b\\"))).toEqual([title("vim README.md")]);
    expect(s.feed(enc("\x1b]1;icon-name\x07"))).toEqual([]);
  });

  test("titles and clipboard writes interleave in stream order", () => {
    const s = new OscSignalScanner();
    expect(
      s.feed(enc(`\x1b]0;shell one\x07text\x1b]52;c;${b64("copy")}\x07\x1b]2;shell two\x07`)),
    ).toEqual([title("shell one"), clip("copy"), title("shell two")]);
  });

  test("a UTF-8 title split across chunks survives", () => {
    const whole = "\x1b]0;café — mást\x07";
    const bytes = enc(whole);
    for (let cut = 1; cut < bytes.length - 1; cut++) {
      const s = new OscSignalScanner();
      const out = [...s.feed(bytes.slice(0, cut)), ...s.feed(bytes.slice(cut))];
      expect(out).toEqual([title("café — mást")]);
    }
  });
});
