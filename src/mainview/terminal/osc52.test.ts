import { describe, expect, test } from "bun:test";
import { Osc52Scanner } from "./osc52";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => btoa(s);

describe("Osc52Scanner", () => {
  test("a BEL-terminated clipboard write decodes to its text", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc(`\x1b]52;c;${b64("hello url")}\x07`))).toEqual(["hello url"]);
  });

  test("an ST-terminated write decodes too", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc(`\x1b]52;c;${b64("st-style")}\x1b\\`))).toEqual(["st-style"]);
  });

  test("a sequence split across arbitrary chunk boundaries still decodes", () => {
    const whole = `\x1b]52;c;${b64("split across chunks")}\x07`;
    for (let cut = 1; cut < whole.length - 1; cut++) {
      const s = new Osc52Scanner();
      const first = s.feed(enc(whole.slice(0, cut)));
      const second = s.feed(enc(whole.slice(cut)));
      expect([...first, ...second]).toEqual(["split across chunks"]);
    }
  });

  test("a query (?) is not a write and yields nothing", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc("\x1b]52;c;?\x07"))).toEqual([]);
  });

  test("other OSC sequences and plain output pass without effect", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc("\x1b]0;title\x07plain text \x1b[31mred\x1b[0m"))).toEqual([]);
    expect(s.feed(enc("\x1b]521;c;AAAA\x07"))).toEqual([]);
  });

  test("multiple writes in one chunk all decode, in order", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc(`\x1b]52;c;${b64("one")}\x07mid\x1b]52;p;${b64("two")}\x07`))).toEqual([
      "one",
      "two",
    ]);
  });

  test("invalid base64 yields nothing rather than garbage", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc("\x1b]52;c;!!!not-base64!!!\x07"))).toEqual([]);
  });

  test("a runaway payload is abandoned at the cap instead of buffering forever", () => {
    const s = new Osc52Scanner();
    expect(s.feed(enc("\x1b]52;c;"))).toEqual([]);
    for (let i = 0; i < 40; i++) {
      expect(s.feed(new Uint8Array(8192).fill(0x41))).toEqual([]);
    }
    expect(s.feed(enc(`\x07after\x1b]52;c;${b64("recovered")}\x07`))).toEqual(["recovered"]);
  });

  test("UTF-8 clipboard content survives the round trip", () => {
    const s = new Osc52Scanner();
    const text = "café 🚀 — ünïcode";
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(s.feed(enc(`\x1b]52;c;${payload}\x07`))).toEqual([text]);
  });
});
