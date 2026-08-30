import { describe, expect, test } from "bun:test";
import type { PaneLayout } from "./paneLayout";
import { chipMenuItems, PANE_COLORS, paneMenuItems, type PaneMenuActions } from "./paneMenu";

const base = "mast-a";
const layout: PaneLayout = {
  groups: [{ id: 1, panes: ["mast-a", "mast-a.2"] }],
  active: 0,
  seq: 2,
  meta: { "mast-a": { label: "agent" } },
};

function recorder() {
  const calls: unknown[][] = [];
  const actions: PaneMenuActions = {
    rename: (s) => calls.push(["rename", s]),
    setColor: (s, c) => calls.push(["setColor", s, c]),
    close: (ss) => calls.push(["close", ss]),
  };
  return { calls, actions };
}

const labelsOf = (items: ReturnType<typeof paneMenuItems>) =>
  items.map((i) => (i.kind === "separator" ? "—" : typeof i.label === "string" ? i.label : "<node>"));

describe("paneMenuItems", () => {
  test("identity first, Close pane last, addressed by the pane's shown name", () => {
    const { actions } = recorder();
    expect(labelsOf(paneMenuItems(layout, "mast-a", base, actions))).toEqual([
      "Rename shell…",
      "Color",
      "Close pane agent",
    ]);
    expect(labelsOf(paneMenuItems(layout, "mast-a.2", base, actions, { "mast-a.2": "mast" }))).toEqual([
      "Rename shell…",
      "Color",
      "Close pane mast",
    ]);
  });

  test("the color submenu offers None plus every swatch and wires the right values", () => {
    const { calls, actions } = recorder();
    const color = paneMenuItems(layout, "mast-a.2", base, actions).find(
      (i) => i.kind === "item" && i.label === "Color",
    );
    const submenu = color!.kind === "item" ? color!.submenu! : [];
    expect(submenu).toHaveLength(1 + PANE_COLORS.length);
    (submenu[0] as { onSelect: () => void }).onSelect();
    (submenu[3] as { onSelect: () => void }).onSelect();
    expect(calls).toEqual([
      ["setColor", "mast-a.2", undefined],
      ["setColor", "mast-a.2", 2],
    ]);
  });

  test("close acts on exactly the one pane", () => {
    const { calls, actions } = recorder();
    const items = paneMenuItems(layout, "mast-a.2", base, actions);
    (items.at(-1) as { onSelect: () => void }).onSelect();
    expect(calls).toEqual([["close", ["mast-a.2"]]]);
  });
});

describe("chipMenuItems", () => {
  test("targets the group's focused pane, separator before Close shell of the whole group", () => {
    const { calls, actions } = recorder();
    const group = layout.groups[0]!;
    const items = chipMenuItems(layout, group, "mast-a.2", base, actions);
    expect(labelsOf(items)).toEqual(["Rename shell…", "Color", "—", "Close shell agent·2"]);
    (items[0] as { onSelect: () => void }).onSelect();
    (items.at(-1) as { onSelect: () => void }).onSelect();
    expect(calls).toEqual([
      ["rename", "mast-a.2"],
      ["close", ["mast-a", "mast-a.2"]],
    ]);
  });

  test("falls back to the group's first pane when focus is elsewhere", () => {
    const { calls, actions } = recorder();
    const group = layout.groups[0]!;
    const items = chipMenuItems(layout, group, "mast-b.9", base, actions);
    expect(labelsOf(items)).toEqual(["Rename shell…", "Color", "—", "Close shell agent·2"]);
    (items[0] as { onSelect: () => void }).onSelect();
    expect(calls).toEqual([["rename", "mast-a"]]);
  });
});
