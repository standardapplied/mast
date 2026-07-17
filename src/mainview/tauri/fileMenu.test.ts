import { describe, expect, test } from "bun:test";
import { fileMenuItems, type FileActions } from "./FileTree";
import type { FileEntry } from "./fileTreeStore";

const noop = () => {};
const actions: FileActions = {
  open: noop,
  openDefault: noop,
  download: noop,
  remove: noop,
  rename: noop,
  newFolder: noop,
  newFile: noop,
  setRoot: noop,
  climbRoot: noop,
  copyPaths: noop,
};

const labels = (entries: FileEntry[], isRoot = false) =>
  fileMenuItems(entries, actions, isRoot)
    .filter((i) => i.kind === "item")
    .map((i) => (i as { label: string }).label);

const file: FileEntry = { name: "a.txt", path: "/d/a.txt", isDir: false, size: 1 };
const dir: FileEntry = { name: "sub", path: "/d/sub", isDir: true, size: 0 };
const root: FileEntry = { name: "d", path: "/d", isDir: true, size: 0 };

describe("fileMenuItems", () => {
  test("file menu opens in the viewer or the default app", () => {
    expect(labels([file])).toEqual([
      "Open",
      "Open in default app",
      "Copy path",
      "Download",
      "Rename…",
      "Delete",
    ]);
  });

  test("dir menu offers re-root and creation, no viewer open", () => {
    expect(labels([dir])).toEqual([
      "Open as root",
      "New file…",
      "New folder…",
      "Copy path",
      "Download folder",
      "Rename…",
      "Delete",
    ]);
  });

  test("the root row creates and downloads but never renames or deletes itself", () => {
    expect(labels([root], true)).toEqual(["New file…", "New folder…", "Copy path", "Download folder"]);
  });

  test("a multi-selection acts in bulk with counts", () => {
    expect(labels([file, dir])).toEqual(["Download 2 items", "Copy paths", "Delete 2 items"]);
  });

  test("bulk actions pass every selected entry through", () => {
    const got: string[][] = [];
    const spy: FileActions = { ...actions, remove: (es) => got.push(es.map((e) => e.path)) };
    const del = fileMenuItems([file, dir], spy).find(
      (i) => i.kind === "item" && i.label === "Delete 2 items",
    );
    (del as { onSelect: () => void }).onSelect();
    expect(got).toEqual([["/d/a.txt", "/d/sub"]]);
  });

  test("Delete is marked danger in both shapes", () => {
    for (const items of [fileMenuItems([file], actions), fileMenuItems([file, dir], actions)]) {
      const del = items.find((i) => i.kind === "item" && String((i as { label: string }).label).startsWith("Delete"));
      expect(del && "danger" in del && del.danger).toBe(true);
    }
  });
});
