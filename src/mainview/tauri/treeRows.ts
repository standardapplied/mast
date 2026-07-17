import type { DirState, FileEntry } from "./fileTreeStore";

/**
 * Flat projection of the file tree: store state + expansion → a depth-annotated
 * row list, so the view can window it (virtualize) instead of recursing through
 * nested lists. Pure — the store implements `TreeSource` directly.
 */

export type TreeSource = {
  rootPath: string | null;
  dir(path: string): DirState | undefined;
  isExpanded(path: string): boolean;
};

export type TreeRow =
  | { kind: "root"; path: string; name: string }
  | { kind: "entry"; entry: FileEntry; depth: number }
  | { kind: "skeleton"; depth: number; key: string }
  | { kind: "error"; message: string; depth: number; key: string }
  | { kind: "empty"; depth: number; key: string }
  | { kind: "truncated"; depth: number; key: string; more: boolean };

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? "/";

export function visibleRows(src: TreeSource): TreeRow[] {
  const root = src.rootPath;
  if (root === null) return [];
  const rows: TreeRow[] = [{ kind: "root", path: root, name: baseName(root) }];
  pushDir(src, root, 1, rows);
  return rows;
}

function pushDir(src: TreeSource, path: string, depth: number, rows: TreeRow[]): void {
  const node = src.dir(path);
  if (!node || node.status === "loading") {
    rows.push({ kind: "skeleton", depth, key: path });
    return;
  }
  if (node.status === "error") {
    rows.push({ kind: "error", message: node.error, depth, key: path });
    return;
  }
  if (node.entries.length === 0) {
    rows.push({ kind: "empty", depth, key: path });
  }
  for (const entry of node.entries) {
    rows.push({ kind: "entry", entry, depth });
    if (entry.isDir && src.isExpanded(entry.path)) pushDir(src, entry.path, depth + 1, rows);
  }
  if (node.truncated) rows.push({ kind: "truncated", depth, key: path, more: node.nextCursor !== undefined });
}
