import { describe, expect, test } from "bun:test";
import { fileMenuItems, type FileActions } from "./FileTree";
import type { FileEntry } from "./fileTreeStore";

const noop = () => {};
const actions: FileActions = {
  edit: noop,
  open: noop,
  download: noop,
  rename: noop,
  remove: noop,
  newFolder: noop,
  setRoot: noop,
  climbRoot: noop,
};

const labels = (entry: FileEntry) =>
  fileMenuItems(entry, actions)
    .filter((i) => i.kind === "item")
    .map((i) => (i as { label: string }).label);

const file: FileEntry = { name: "a.txt", path: "/d/a.txt", isDir: false, size: 1 };
const dir: FileEntry = { name: "sub", path: "/d/sub", isDir: true, size: 0 };

describe("fileMenuItems", () => {
  test("file menu offers Edit/Open, no New folder or Open as root", () => {
    const items = labels(file);
    expect(items).toEqual(["Edit", "Open", "Download", "Rename…", "Delete"]);
  });

  test("dir menu offers Open as root + New folder, no Edit/Open", () => {
    const items = labels(dir);
    expect(items).toEqual(["Open as root", "New folder…", "Download folder", "Rename…", "Delete"]);
  });

  test("Delete is marked danger", () => {
    const del = fileMenuItems(file, actions).find(
      (i) => i.kind === "item" && i.label === "Delete",
    );
    expect(del && "danger" in del && del.danger).toBe(true);
  });
});
