import { describe, expect, test } from "bun:test";
import { encodeKey, type KeyStroke } from "./input";

function bytes(stroke: KeyStroke): number[] | null {
  const out = encodeKey(stroke);
  return out === null ? null : Array.from(out);
}

function str(stroke: KeyStroke): string | null {
  const out = encodeKey(stroke);
  return out === null ? null : new TextDecoder().decode(out);
}

describe("encodeKey", () => {
  test("a bare printable character is its UTF-8 bytes", () => {
    expect(bytes({ key: "a" })).toEqual([0x61]);
    expect(bytes({ key: "Z" })).toEqual([0x5a]);
    expect(bytes({ key: "7" })).toEqual([0x37]);
    expect(bytes({ key: "€" })).toEqual([0xe2, 0x82, 0xac]);
  });

  test("an emoji or multi-code-point grapheme is sent whole", () => {
    expect(str({ key: "😀" })).toBe("😀");
  });

  test("bare modifier keys send nothing", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"]) {
      expect(bytes({ key })).toBeNull();
    }
  });

  test("the enter/tab/backspace/escape controls", () => {
    expect(bytes({ key: "Enter" })).toEqual([0x0d]);
    expect(bytes({ key: "Tab" })).toEqual([0x09]);
    expect(bytes({ key: "Backspace" })).toEqual([0x7f]);
    expect(bytes({ key: "Escape" })).toEqual([0x1b]);
  });

  test("arrow keys are CSI sequences", () => {
    expect(str({ key: "ArrowUp" })).toBe("\x1b[A");
    expect(str({ key: "ArrowDown" })).toBe("\x1b[B");
    expect(str({ key: "ArrowRight" })).toBe("\x1b[C");
    expect(str({ key: "ArrowLeft" })).toBe("\x1b[D");
  });

  test("navigation and editing keys", () => {
    expect(str({ key: "Home" })).toBe("\x1b[H");
    expect(str({ key: "End" })).toBe("\x1b[F");
    expect(str({ key: "PageUp" })).toBe("\x1b[5~");
    expect(str({ key: "PageDown" })).toBe("\x1b[6~");
    expect(str({ key: "Insert" })).toBe("\x1b[2~");
    expect(str({ key: "Delete" })).toBe("\x1b[3~");
  });

  test("function keys F1–F12", () => {
    expect(str({ key: "F1" })).toBe("\x1bOP");
    expect(str({ key: "F4" })).toBe("\x1bOS");
    expect(str({ key: "F5" })).toBe("\x1b[15~");
    expect(str({ key: "F12" })).toBe("\x1b[24~");
  });

  test("Ctrl+letter maps to its control byte, case-insensitively", () => {
    expect(bytes({ key: "a", ctrl: true })).toEqual([0x01]);
    expect(bytes({ key: "A", ctrl: true })).toEqual([0x01]);
    expect(bytes({ key: "c", ctrl: true })).toEqual([0x03]);
    expect(bytes({ key: "z", ctrl: true })).toEqual([0x1a]);
  });

  test("the classic Ctrl symbol controls", () => {
    expect(bytes({ key: " ", ctrl: true })).toEqual([0x00]);
    expect(bytes({ key: "[", ctrl: true })).toEqual([0x1b]);
    expect(bytes({ key: "\\", ctrl: true })).toEqual([0x1c]);
    expect(bytes({ key: "]", ctrl: true })).toEqual([0x1d]);
    expect(bytes({ key: "?", ctrl: true })).toEqual([0x7f]);
    expect(bytes({ key: "@", ctrl: true })).toEqual([0x00]);
  });

  test("Ctrl with a non-control key falls through to the character", () => {
    // Ctrl+1 has no control byte; send the digit.
    expect(bytes({ key: "1", ctrl: true })).toEqual([0x31]);
  });

  test("Alt/Meta prefix ESC (meta-sends-escape)", () => {
    expect(str({ key: "b", alt: true })).toBe("\x1bb");
    expect(str({ key: "f", meta: true })).toBe("\x1bf");
    expect(str({ key: "ArrowLeft", alt: true })).toBe("\x1b\x1b[D");
  });

  test("unhandled keys send nothing", () => {
    expect(bytes({ key: "F13" })).toBeNull();
    expect(bytes({ key: "" })).toBeNull();
    expect(bytes({ key: "AudioVolumeUp" })).toBeNull();
  });
});
