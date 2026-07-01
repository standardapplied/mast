import { describe, expect, test } from "bun:test";
import { WindowRegistry } from "./window-registry";

describe("WindowRegistry", () => {
  test("newest window is focused; focus promotes to front", () => {
    const reg = new WindowRegistry<string>();
    reg.add("a");
    reg.add("b");
    expect(reg.focused).toBe("b");

    reg.focus("a");
    expect(reg.focused).toBe("a");
    expect(reg.all).toEqual(["a", "b"]);
  });

  test("remove drops the entry and updates focus", () => {
    const reg = new WindowRegistry<string>();
    reg.add("a");
    reg.add("b");
    reg.remove("b");
    expect(reg.size).toBe(1);
    expect(reg.focused).toBe("a");
  });

  test("broadcast fans out to every entry in order", () => {
    const reg = new WindowRegistry<string>();
    reg.add("a");
    reg.add("b");
    const seen: string[] = [];
    reg.broadcast((e) => seen.push(e));
    expect(seen).toEqual(["b", "a"]);
  });

  test("focusing an unknown entry is a no-op", () => {
    const reg = new WindowRegistry<string>();
    reg.add("a");
    reg.focus("ghost");
    expect(reg.all).toEqual(["a"]);
  });
});
