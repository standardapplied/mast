import { describe, expect, test } from "bun:test";
import { addTab, nextActive, tabKey, type Tab } from "./terminalTabs";

const tab = (target: string | undefined, label = target ?? "node"): Tab => ({
  target,
  label,
  key: tabKey(target),
});

describe("addTab", () => {
  test("appends a new project", () => {
    const tabs = addTab([tab("a")], "b", "b");
    expect(tabs.map((t) => t.key)).toEqual(["a", "b"]);
  });
  test("no-op when already open", () => {
    const start = [tab("a")];
    expect(addTab(start, "a", "a")).toBe(start);
  });
  test("node uses a stable key", () => {
    expect(tabKey(undefined)).toBe("__node__");
    expect(addTab([], undefined, "node").map((t) => t.key)).toEqual(["__node__"]);
  });
});

describe("nextActive", () => {
  const tabs = [tab("a"), tab("b"), tab("c")];
  test("closing a non-active tab keeps the active one", () => {
    expect(nextActive(tabs, "a", "b")).toBe("b");
  });
  test("closing the active tab falls to the last remaining", () => {
    expect(nextActive(tabs, "c", "c")).toBe("b");
  });
  test("closing the last tab yields none", () => {
    expect(nextActive([tab("a")], "a", "a")).toBeNull();
  });
});
