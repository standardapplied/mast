import { describe, expect, test } from "bun:test";
import {
  ACTION,
  GHOSTTY_KEY,
  ghosttyKeyOf,
  keyEventFor,
  MODS,
} from "./input";

describe("ghosttyKeyOf", () => {
  test("W3C codes map straight into libghostty's key space", () => {
    expect(ghosttyKeyOf("KeyA", "a")).toBe(GHOSTTY_KEY.indexOf("KeyA"));
    expect(ghosttyKeyOf("Digit7", "7")).toBe(GHOSTTY_KEY.indexOf("Digit7"));
    expect(ghosttyKeyOf("ArrowUp", "ArrowUp")).toBe(GHOSTTY_KEY.indexOf("ArrowUp"));
    expect(ghosttyKeyOf("F12", "F12")).toBe(GHOSTTY_KEY.indexOf("F12"));
    expect(ghosttyKeyOf("NumpadEnter", "Enter")).toBe(GHOSTTY_KEY.indexOf("NumpadEnter"));
  });

  test("the key space itself is anchored (canary for a wasm re-pin shifting the enum)", () => {
    // Spot checks across every section of the C enum; these ordinals are the ABI.
    expect(GHOSTTY_KEY.indexOf("Unidentified")).toBe(0);
    expect(GHOSTTY_KEY.indexOf("Backquote")).toBe(1);
    expect(GHOSTTY_KEY.indexOf("Digit0")).toBe(6);
    expect(GHOSTTY_KEY.indexOf("KeyA")).toBe(20);
    expect(GHOSTTY_KEY.indexOf("KeyZ")).toBe(45);
    expect(GHOSTTY_KEY.indexOf("AltLeft")).toBe(51);
    expect(GHOSTTY_KEY.indexOf("Enter")).toBe(58);
    expect(GHOSTTY_KEY.indexOf("Space")).toBe(63);
    expect(GHOSTTY_KEY.indexOf("Delete")).toBe(68);
    expect(GHOSTTY_KEY.indexOf("ArrowDown")).toBe(75);
    expect(GHOSTTY_KEY.indexOf("ArrowUp")).toBe(78);
    expect(GHOSTTY_KEY.indexOf("NumLock")).toBe(79);
    expect(GHOSTTY_KEY.indexOf("Escape")).toBe(120);
    expect(GHOSTTY_KEY.indexOf("F1")).toBe(121);
    expect(GHOSTTY_KEY.indexOf("Paste")).toBe(GHOSTTY_KEY.length - 1);
  });

  test("a missing code is derived from the key where that is unambiguous", () => {
    expect(ghosttyKeyOf(undefined, "a")).toBe(GHOSTTY_KEY.indexOf("KeyA"));
    expect(ghosttyKeyOf(undefined, "Z")).toBe(GHOSTTY_KEY.indexOf("KeyZ"));
    expect(ghosttyKeyOf(undefined, "5")).toBe(GHOSTTY_KEY.indexOf("Digit5"));
    expect(ghosttyKeyOf(undefined, " ")).toBe(GHOSTTY_KEY.indexOf("Space"));
    expect(ghosttyKeyOf(undefined, "Enter")).toBe(GHOSTTY_KEY.indexOf("Enter"));
    expect(ghosttyKeyOf(undefined, "ArrowLeft")).toBe(GHOSTTY_KEY.indexOf("ArrowLeft"));
    expect(ghosttyKeyOf(undefined, "F5")).toBe(GHOSTTY_KEY.indexOf("F5"));
  });

  test("the unknown falls to Unidentified, never a wrong key", () => {
    expect(ghosttyKeyOf("Gamepad3", "x")).toBe(0);
    expect(ghosttyKeyOf(undefined, "∆")).toBe(0);
  });
});

describe("keyEventFor", () => {
  test("a plain letter press carries its text and unshifted codepoint", () => {
    const e = keyEventFor({ key: "a", code: "KeyA" });
    expect(e.key).toBe(GHOSTTY_KEY.indexOf("KeyA"));
    expect(e.mods).toBe(0);
    expect(e.utf8).toBe("a");
    expect(e.unshifted).toBe(0x61);
    expect(e.action).toBe(ACTION.PRESS);
  });

  test("modifiers become the ghostty bitmask", () => {
    const e = keyEventFor({ key: "A", code: "KeyA", shift: true, ctrl: true, alt: true, meta: true, caps: true });
    expect(e.mods).toBe(MODS.SHIFT | MODS.CTRL | MODS.ALT | MODS.SUPER | MODS.CAPS);
  });

  test("shifted text marks shift as consumed; an arrow's shift stays unconsumed", () => {
    const shifted = keyEventFor({ key: "A", code: "KeyA", shift: true });
    expect(shifted.utf8).toBe("A");
    expect(shifted.unshifted).toBe(0x61);
    expect(shifted.consumedMods & MODS.SHIFT).toBe(MODS.SHIFT);
    const arrow = keyEventFor({ key: "ArrowUp", code: "ArrowUp", shift: true });
    expect(arrow.utf8).toBe("");
    expect(arrow.consumedMods).toBe(0);
  });

  test("ctrl and cmd suppress the text — the encoder derives those bytes from the key", () => {
    expect(keyEventFor({ key: "a", code: "KeyA", ctrl: true }).utf8).toBe("");
    expect(keyEventFor({ key: "a", code: "KeyA", meta: true }).utf8).toBe("");
  });

  test("the unshifted codepoint comes from the physical key, not the produced char", () => {
    // Shift+2 produces "@" but the key without shift is '2'.
    expect(keyEventFor({ key: "@", code: "Digit2", shift: true }).unshifted).toBe(0x32);
    // macOS Option+B composes "∫" but the key without modifiers is 'b'.
    expect(keyEventFor({ key: "∫", code: "KeyB", alt: true }).unshifted).toBe(0x62);
  });

  test("named keys carry no text", () => {
    expect(keyEventFor({ key: "Enter", code: "Enter" }).utf8).toBe("");
    expect(keyEventFor({ key: "Backspace", code: "Backspace" }).utf8).toBe("");
  });

  test("a held key repeats instead of pressing", () => {
    expect(keyEventFor({ key: "a", code: "KeyA", repeat: true }).action).toBe(ACTION.REPEAT);
  });

  test("IME composition is flagged so nothing half-composed hits the pty", () => {
    expect(keyEventFor({ key: "Dead", code: "KeyE", composing: true }).composing).toBe(true);
    expect(keyEventFor({ key: "Dead", code: "KeyE" }).composing).toBe(true);
  });
});
