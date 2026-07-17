import { describe, expect, test } from "bun:test";
import type { FileEntry } from "./fileTreeStore";
import { visibleRows, type TreeSource } from "./treeRows";

const entry = (path: string, isDir = false): FileEntry => ({
  name: path.split("/").pop()!,
  path,
  isDir,
  size: 0,
});

function source(spec: {
  root?: string | null;
  dirs?: Record<string, { entries: FileEntry[]; truncated?: boolean } | "loading" | { error: string }>;
  expanded?: string[];
}): TreeSource {
  const dirs = spec.dirs ?? {};
  const expanded = new Set(spec.expanded ?? []);
  return {
    rootPath: spec.root === undefined ? "/r" : spec.root,
    dir: (path) => {
      const d = dirs[path];
      if (!d) return undefined;
      if (d === "loading") return { status: "loading" };
      if ("error" in d) return { status: "error", error: d.error };
      return { status: "ready", entries: d.entries, stale: false, truncated: d.truncated };
    },
    isExpanded: (path) => expanded.has(path),
  };
}

describe("visibleRows", () => {
  test("no root yet → no rows", () => {
    expect(visibleRows(source({ root: null }))).toEqual([]);
  });

  test("pins the root row first, then the root's entries at depth 1", () => {
    const rows = visibleRows(
      source({ dirs: { "/r": { entries: [entry("/r/a", true), entry("/r/b.txt")] } } }),
    );
    expect(rows[0]).toEqual({ kind: "root", path: "/r", name: "r" });
    expect(rows.slice(1)).toEqual([
      { kind: "entry", entry: entry("/r/a", true), depth: 1 },
      { kind: "entry", entry: entry("/r/b.txt"), depth: 1 },
    ]);
  });

  test("expanded directories flatten depth-first with depth annotations", () => {
    const rows = visibleRows(
      source({
        dirs: {
          "/r": { entries: [entry("/r/a", true), entry("/r/z.txt")] },
          "/r/a": { entries: [entry("/r/a/b", true), entry("/r/a/c.txt")] },
          "/r/a/b": { entries: [entry("/r/a/b/d.txt")] },
        },
        expanded: ["/r/a", "/r/a/b"],
      }),
    );
    expect(rows.map((r) => (r.kind === "entry" ? `${r.depth}:${r.entry.path}` : r.kind))).toEqual([
      "root",
      "1:/r/a",
      "2:/r/a/b",
      "3:/r/a/b/d.txt",
      "2:/r/a/c.txt",
      "1:/r/z.txt",
    ]);
  });

  test("collapsed directories contribute no child rows", () => {
    const rows = visibleRows(
      source({
        dirs: {
          "/r": { entries: [entry("/r/a", true)] },
          "/r/a": { entries: [entry("/r/a/x.txt")] },
        },
      }),
    );
    expect(rows).toHaveLength(2);
  });

  test("an expanded but unloaded directory shows a skeleton row", () => {
    const rows = visibleRows(
      source({
        dirs: { "/r": { entries: [entry("/r/a", true)] }, "/r/a": "loading" },
        expanded: ["/r/a"],
      }),
    );
    expect(rows[2]).toEqual({ kind: "skeleton", depth: 2, key: "/r/a" });
  });

  test("an errored directory shows an error row", () => {
    const rows = visibleRows(
      source({
        dirs: { "/r": { entries: [entry("/r/a", true)] }, "/r/a": { error: "denied" } },
        expanded: ["/r/a"],
      }),
    );
    expect(rows[2]).toEqual({ kind: "error", message: "denied", depth: 2, key: "/r/a" });
  });

  test("an empty expanded directory shows an empty row", () => {
    const rows = visibleRows(
      source({
        dirs: { "/r": { entries: [entry("/r/a", true)] }, "/r/a": { entries: [] } },
        expanded: ["/r/a"],
      }),
    );
    expect(rows[2]).toEqual({ kind: "empty", depth: 2, key: "/r/a" });
  });

  test("a truncated deep listing appends a subtle more row after its entries", () => {
    const rows = visibleRows(
      source({
        dirs: { "/r": { entries: [entry("/r/a", true)], truncated: true } },
      }),
    );
    expect(rows.at(-1)).toEqual({ kind: "truncated", depth: 1, key: "/r" });
  });

  test("a root error shows only the error row under the root row", () => {
    const rows = visibleRows(source({ dirs: { "/r": { error: "boom" } } }));
    expect(rows).toEqual([
      { kind: "root", path: "/r", name: "r" },
      { kind: "error", message: "boom", depth: 1, key: "/r" },
    ]);
  });
});
