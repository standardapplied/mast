/**
 * Pure drag-drop routing: given the DOM element under the cursor, decide where
 * a dropped file goes — into a specific tree directory, into the terminal, or
 * nowhere. Kept separate from the coordinator so the rules are unit-testable.
 */

export type DropTarget =
  | { kind: "tree"; dir: string }
  | { kind: "terminal" }
  | { kind: "none" };

/** POSIX parent directory of an absolute path (`/a/b/c` → `/a/b`, `/a` → `/`). */
export function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * Classify the drop from the element under the cursor. A file row targets its
 * parent directory; a directory row targets itself; empty tree space targets
 * the root; the terminal pane targets the terminal.
 */
export function classifyDrop(el: Element | null, rootDir: string | null): DropTarget {
  if (!el) return { kind: "none" };
  if (el.closest(".terminal-pane")) return { kind: "terminal" };
  if (!el.closest(".file-tree")) return { kind: "none" };

  const row = el.closest("[data-path]");
  if (row) {
    const path = row.getAttribute("data-path") ?? "";
    const isDir = row.getAttribute("data-dir") === "true";
    return { kind: "tree", dir: isDir ? path : parentDir(path) };
  }
  return rootDir ? { kind: "tree", dir: rootDir } : { kind: "none" };
}

/** Single-quote a path for safe injection onto a shell command line. */
export function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
