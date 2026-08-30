import { describe, expect, test } from "bun:test";
import {
  baseSessionFor,
  defaultLayout,
  labelFor,
  newGroup,
  nextSessionName,
  paneCount,
  parseLayout,
  projectFor,
  reconcile,
  removePane,
  sessionsOf,
  shortTitle,
  splitGroup,
  titleOf,
  withPaneMeta,
} from "./paneLayout";

describe("session naming", () => {
  test("the node and each project get their own base session", () => {
    expect(baseSessionFor(undefined)).toBe("mast-node");
    expect(baseSessionFor("chorus")).toBe("mast-chorus");
    expect(projectFor(undefined)).toBe("");
    expect(projectFor("chorus")).toBe("chorus");
  });

  test("new sessions take the lowest free ordinal", () => {
    expect(nextSessionName([], "mast-a")).toBe("mast-a");
    expect(nextSessionName(["mast-a"], "mast-a")).toBe("mast-a.2");
    expect(nextSessionName(["mast-a", "mast-a.2"], "mast-a")).toBe("mast-a.3");
    expect(nextSessionName(["mast-a", "mast-a.3"], "mast-a")).toBe("mast-a.2");
  });

  test("labels are the ordinal", () => {
    expect(labelFor("mast-a", "mast-a")).toBe("1");
    expect(labelFor("mast-a.2", "mast-a")).toBe("2");
    expect(labelFor("mast-a.17", "mast-a")).toBe("17");
  });
});

describe("reconcile", () => {
  test("no stored layout and no live sessions yields the single base pane", () => {
    expect(reconcile(null, [], "mast-a")).toEqual(defaultLayout("mast-a"));
    expect(defaultLayout("mast-a")).toEqual({
      groups: [{ id: 1, panes: ["mast-a"] }],
      active: 0,
      seq: 2,
    });
  });

  test("stored arrangement and group identities survive; the host adds what the client forgot", () => {
    const stored = { groups: [{ id: 7, panes: ["mast-a", "mast-a.2"] }], active: 0, seq: 8 };
    const out = reconcile(stored, ["mast-a", "mast-a.2", "mast-a.3"], "mast-a");
    expect(out.groups).toEqual([
      { id: 7, panes: ["mast-a", "mast-a.2"] },
      { id: 8, panes: ["mast-a.3"] },
    ]);
    expect(out.seq).toBe(9);
  });

  test("a stored pane whose session died is kept — reopening recreates the shell", () => {
    const stored = { groups: [{ id: 1, panes: ["mast-a"] }, { id: 2, panes: ["mast-a.2"] }], active: 1, seq: 3 };
    expect(reconcile(stored, [], "mast-a")).toEqual(stored);
  });

  test("live sessions from another Mac appear as their own tabs, in ordinal order", () => {
    const out = reconcile(null, ["mast-a.3", "mast-a", "mast-a.2"], "mast-a");
    expect(out.groups.map((g) => g.panes)).toEqual([["mast-a"], ["mast-a.2"], ["mast-a.3"]]);
    expect(new Set(out.groups.map((g) => g.id)).size).toBe(3);
    expect(out.active).toBe(0);
  });

  test("a garbled stored active index is clamped", () => {
    const stored = { groups: [{ id: 1, panes: ["mast-a"] }], active: 9, seq: 2 };
    expect(reconcile(stored, [], "mast-a").active).toBe(0);
  });

  test("foreign sessions on the socket never leak into this tab", () => {
    const out = reconcile(null, ["mast-other", "mast-a", "mast-ab.2"], "mast-a");
    expect(out.groups.map((g) => g.panes)).toEqual([["mast-a"]]);
  });

  test("a stale seq is repaired so new groups never collide with stored ids", () => {
    const stored = { groups: [{ id: 9, panes: ["mast-a"] }], active: 0, seq: 2 };
    const out = reconcile(stored, ["mast-a.2"], "mast-a");
    expect(out.groups[1]!.id).toBe(10);
  });
});

describe("parseLayout", () => {
  test("round-trips a healthy layout", () => {
    const layout = { groups: [{ id: 3, panes: ["mast-a", "mast-a.2"] }], active: 0, seq: 4 };
    expect(parseLayout(JSON.stringify(layout))).toEqual(layout);
  });

  test("rejects malformed shapes instead of poisoning the tab", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout("not json")).toBeNull();
    expect(parseLayout(JSON.stringify({ groups: ["mast-a"], active: 0 }))).toBeNull();
    expect(parseLayout(JSON.stringify({ groups: [{ id: "x", panes: ["a"] }], active: 0, seq: 1 }))).toBeNull();
    expect(parseLayout(JSON.stringify({ groups: [{ id: 1, panes: [2] }], active: 0, seq: 2 }))).toBeNull();
    expect(parseLayout(JSON.stringify({ groups: [{ id: 1, panes: [] }], active: 0, seq: 2 }))).toBeNull();
    expect(parseLayout(JSON.stringify({ groups: [{ id: 1, panes: ["a"] }], active: "0", seq: 2 }))).toBeNull();
  });
});

describe("editing", () => {
  const two = { groups: [{ id: 1, panes: ["a"] }, { id: 2, panes: ["b"] }], active: 0, seq: 3 };

  test("newGroup appends with a fresh identity and activates", () => {
    expect(newGroup(two, "c")).toEqual({
      groups: [{ id: 1, panes: ["a"] }, { id: 2, panes: ["b"] }, { id: 3, panes: ["c"] }],
      active: 2,
      seq: 4,
    });
  });

  test("splitGroup adds a pane beside the active group's panes, identity unchanged", () => {
    expect(splitGroup(two, 0, "c")).toEqual({
      groups: [{ id: 1, panes: ["a", "c"] }, { id: 2, panes: ["b"] }],
      active: 0,
      seq: 3,
    });
  });

  test("removePane keeps the group's identity when a sibling survives", () => {
    const layout = { groups: [{ id: 1, panes: ["a", "c"] }, { id: 2, panes: ["b"] }], active: 1, seq: 3 };
    expect(removePane(layout, "c", "base")).toEqual({
      groups: [{ id: 1, panes: ["a"] }, { id: 2, panes: ["b"] }],
      active: 1,
      seq: 3,
    });
  });

  test("removePane drops an emptied group and clamps active", () => {
    expect(removePane(two, "b", "base")).toEqual({
      groups: [{ id: 1, panes: ["a"] }],
      active: 0,
      seq: 3,
    });
  });

  test("removing the last pane falls back to the default layout", () => {
    const one = { groups: [{ id: 5, panes: ["a"] }], active: 0, seq: 6 };
    expect(removePane(one, "a", "mast-x")).toEqual(defaultLayout("mast-x"));
  });

  test("paneCount and sessionsOf see every pane across groups", () => {
    const layout = { groups: [{ id: 1, panes: ["a", "c"] }, { id: 2, panes: ["b"] }], active: 0, seq: 3 };
    expect(paneCount(layout)).toBe(3);
    expect(sessionsOf(layout)).toEqual(["a", "c", "b"]);
  });
});

describe("pane identity (rename + color)", () => {
  const base = "mast-a";
  const layout = { groups: [{ id: 1, panes: ["mast-a", "mast-a.2"] }], active: 0, seq: 2 };

  test("a pane's title is its custom label, then its live shell title, then the ordinal", () => {
    expect(titleOf(layout, "mast-a", base)).toBe("1");
    expect(titleOf(layout, "mast-a", base, { "mast-a": "mast" })).toBe("mast");
    const named = withPaneMeta(layout, "mast-a", { label: "agent" });
    expect(titleOf(named, "mast-a", base, { "mast-a": "mast" })).toBe("agent");
    expect(titleOf(named, "mast-a.2", base)).toBe("2");
  });

  test("shortTitle distills the stock bash title down to the working directory's name", () => {
    expect(shortTitle("dev@snout: ~/workspace/mast")).toBe("mast");
    expect(shortTitle("dev@snout: ~")).toBe("~");
    expect(shortTitle("dev@snout: /")).toBe("/");
    expect(shortTitle("vim README.md")).toBe("vim README.md");
    expect(shortTitle("  ")).toBe("");
    expect(shortTitle("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });

  test("renaming to blank clears back to the ordinal; color survives independently", () => {
    let l = withPaneMeta(layout, "mast-a", { label: "agent", color: 3 });
    l = withPaneMeta(l, "mast-a", { label: "" });
    expect(titleOf(l, "mast-a", base)).toBe("1");
    expect(l.meta?.["mast-a"]).toEqual({ color: 3 });
    l = withPaneMeta(l, "mast-a", { color: undefined });
    expect(l.meta?.["mast-a"]).toBeUndefined();
  });

  test("opening or splitting a shell never touches existing identities", () => {
    const named = withPaneMeta(layout, "mast-a", { label: "agent", color: 3 });
    expect(newGroup(named, "mast-a.3").meta).toEqual(named.meta);
    expect(splitGroup(named, 0, "mast-a.3").meta).toEqual(named.meta);
  });

  test("closing a pane drops its identity", () => {
    const named = withPaneMeta(layout, "mast-a.2", { label: "logs", color: 1 });
    const closed = removePane(named, "mast-a.2", base);
    expect(closed.meta?.["mast-a.2"]).toBeUndefined();
    expect(closed.groups).toEqual([{ id: 1, panes: ["mast-a"] }]);
  });

  test("reconcile keeps identity for surviving panes and sheds orphans", () => {
    const stored = {
      groups: [{ id: 1, panes: ["mast-a"] }],
      active: 0,
      seq: 2,
      meta: { "mast-a": { label: "agent" }, "mast-a.9": { label: "ghost" } },
    };
    const out = reconcile(stored, [], base);
    expect(out.meta).toEqual({ "mast-a": { label: "agent" } });
  });

  test("identity round-trips through parseLayout; malformed meta heals to none", () => {
    const named = withPaneMeta(layout, "mast-a", { label: "agent", color: 5 });
    expect(parseLayout(JSON.stringify(named))).toEqual(named);
    const garbled = JSON.stringify({ ...layout, meta: { "mast-a": { label: 7, color: "red" } } });
    expect(parseLayout(garbled)?.meta).toBeUndefined();
  });
});
