import { describe, expect, test } from "bun:test";
import {
  baseSessionFor,
  defaultLayout,
  labelFor,
  newGroup,
  nextSessionName,
  paneCount,
  projectFor,
  reconcile,
  removePane,
  sessionsOf,
  splitGroup,
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
    expect(defaultLayout("mast-a")).toEqual({ groups: [["mast-a"]], active: 0 });
  });

  test("stored arrangement survives; the host adds what the client forgot", () => {
    const stored = { groups: [["mast-a", "mast-a.2"]], active: 0 };
    const out = reconcile(stored, ["mast-a", "mast-a.2", "mast-a.3"], "mast-a");
    expect(out.groups).toEqual([["mast-a", "mast-a.2"], ["mast-a.3"]]);
  });

  test("a stored pane whose session died is kept — reopening recreates the shell", () => {
    const stored = { groups: [["mast-a"], ["mast-a.2"]], active: 1 };
    const out = reconcile(stored, [], "mast-a");
    expect(out).toEqual(stored);
  });

  test("live sessions from another Mac appear as their own tabs, in ordinal order", () => {
    const out = reconcile(null, ["mast-a.3", "mast-a", "mast-a.2"], "mast-a");
    expect(out.groups).toEqual([["mast-a"], ["mast-a.2"], ["mast-a.3"]]);
    expect(out.active).toBe(0);
  });

  test("a garbled stored active index is clamped", () => {
    const out = reconcile({ groups: [["mast-a"]], active: 9 }, [], "mast-a");
    expect(out.active).toBe(0);
  });

  test("foreign sessions on the socket never leak into this tab", () => {
    const out = reconcile(null, ["mast-other", "mast-a", "mast-ab.2"], "mast-a");
    expect(out.groups).toEqual([["mast-a"]]);
  });
});

describe("editing", () => {
  const two = { groups: [["a"], ["b"]], active: 0 };

  test("newGroup appends and activates", () => {
    expect(newGroup(two, "c")).toEqual({ groups: [["a"], ["b"], ["c"]], active: 2 });
  });

  test("splitGroup adds a pane beside the active group's panes", () => {
    expect(splitGroup(two, 0, "c")).toEqual({ groups: [["a", "c"], ["b"]], active: 0 });
  });

  test("removePane drops the pane, then the empty group, and clamps active", () => {
    const layout = { groups: [["a", "c"], ["b"]], active: 1 };
    expect(removePane(layout, "c", "base")).toEqual({ groups: [["a"], ["b"]], active: 1 });
    expect(removePane({ groups: [["a"], ["b"]], active: 1 }, "b", "base")).toEqual({
      groups: [["a"]],
      active: 0,
    });
  });

  test("removing the last pane falls back to the default layout", () => {
    expect(removePane({ groups: [["a"]], active: 0 }, "a", "mast-x")).toEqual(
      defaultLayout("mast-x"),
    );
  });

  test("paneCount and sessionsOf see every pane across groups", () => {
    const layout = { groups: [["a", "c"], ["b"]], active: 0 };
    expect(paneCount(layout)).toBe(3);
    expect(sessionsOf(layout)).toEqual(["a", "c", "b"]);
  });
});
