import { describe, expect, test } from "bun:test";
import { KITTY_DISAMBIGUATE, KittyKeyboardBridge } from "./kittyKeyboard";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("KittyKeyboardBridge", () => {
  test("answers the support query with the active flags", () => {
    const bridge = new KittyKeyboardBridge();
    expect(bridge.feed(bytes("\x1b[?u"))).toBe("\x1b[?0u");
    bridge.feed(bytes("\x1b[>1u"));
    expect(bridge.feed(bytes("\x1b[?u"))).toBe("\x1b[?1u");
  });

  test("tracks push and pop like the app's enable/disable lifecycle", () => {
    const bridge = new KittyKeyboardBridge();
    expect(bridge.flags).toBe(0);
    bridge.feed(bytes("\x1b[>5u"));
    expect(bridge.flags & KITTY_DISAMBIGUATE).toBe(1);
    bridge.feed(bytes("\x1b[>8u"));
    expect(bridge.flags).toBe(8);
    bridge.feed(bytes("\x1b[<1u"));
    expect(bridge.flags).toBe(5);
    bridge.feed(bytes("\x1b[<u"));
    expect(bridge.flags).toBe(0);
  });

  test("pop below the stack floor leaves flags disabled", () => {
    const bridge = new KittyKeyboardBridge();
    bridge.feed(bytes("\x1b[>1u\x1b[<42u"));
    expect(bridge.flags).toBe(0);
  });

  test("set replaces, ors, and clears bits on the active entry", () => {
    const bridge = new KittyKeyboardBridge();
    bridge.feed(bytes("\x1b[=5;1u"));
    expect(bridge.flags).toBe(5);
    bridge.feed(bytes("\x1b[=2;2u"));
    expect(bridge.flags).toBe(7);
    bridge.feed(bytes("\x1b[=4;3u"));
    expect(bridge.flags).toBe(3);
  });

  test("a sequence split across PTY chunks still parses", () => {
    const bridge = new KittyKeyboardBridge();
    expect(bridge.feed(bytes("output\x1b[>"))).toBe("");
    expect(bridge.feed(bytes("1u more"))).toBe("");
    expect(bridge.flags).toBe(1);
    expect(bridge.feed(bytes("\x1b["))).toBe("");
    expect(bridge.feed(bytes("?u"))).toBe("\x1b[?1u");
  });

  test("full reset (RIS) clears the stack", () => {
    const bridge = new KittyKeyboardBridge();
    bridge.feed(bytes("\x1b[>1u"));
    bridge.feed(bytes("\x1bc"));
    expect(bridge.flags).toBe(0);
  });

  test("ordinary output, other CSI finals, and binary noise are ignored", () => {
    const bridge = new KittyKeyboardBridge();
    const noise = "plain text\x1b[31mred\x1b[0m\x1b[2J\x1b[?25h\x00\xff\x1b]0;title\x07";
    expect(bridge.feed(bytes(noise))).toBe("");
    expect(bridge.flags).toBe(0);
    expect(bridge.feed(bytes("\x1b[?u"))).toBe("\x1b[?0u");
  });

  test("a dangling escape never grows the carry-over unbounded", () => {
    const bridge = new KittyKeyboardBridge();
    bridge.feed(bytes("\x1b[0;1;2;3;4;5;6;7;8;9"));
    expect(bridge.feed(bytes("m\x1b[?u"))).toBe("\x1b[?0u");
  });
});
