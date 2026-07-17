import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import { Folder } from "../components/icons";
import { parentDir } from "./dropTarget";
import type { FileEntry, FileTreeStore } from "./fileTreeStore";
import { clearSelection, click, EMPTY_SELECTION, rangeTo, toggle } from "./selection";
import { visibleRows, type TreeRow } from "./treeRows";

export type { FileEntry, FsApi, FsListing } from "./fileTreeStore";

/** Fixed row heights (px) — the windowing math and CSS both rely on them;
 *  ≤900px uses the taller touch-friendly row. */
export const ROW_HEIGHT = 24;
export const ROW_HEIGHT_TOUCH = 32;
const NARROW_QUERY = "(max-width: 900px)";
const OVERSCAN = 8;
const FALLBACK_VIEWPORT = 600;

type Menu = { x: number; y: number; entries: FileEntry[] };

export type FileActions = {
  /** Open in the viewer/editor pane. */
  open: (entry: FileEntry) => void;
  /** Download to ~/Downloads and open with the OS default app. */
  openDefault: (entry: FileEntry) => void;
  download: (entries: FileEntry[]) => void;
  remove: (entries: FileEntry[]) => void;
  rename: (entry: FileEntry) => void;
  newFolder: (dir: string) => void;
  newFile: (dir: string) => void;
  setRoot: (entry: FileEntry) => void;
  climbRoot: () => void;
  copyPaths: (paths: string[]) => void;
};

/** The right-click menu: multi-selections act in bulk, single entries get the
 *  full set, the pinned root row creates/downloads but never renames itself. */
export function fileMenuItems(entries: FileEntry[], a: FileActions, isRoot = false): MenuNode[] {
  if (entries.length > 1) {
    const n = entries.length;
    return [
      { kind: "item", label: `Download ${n} items`, hint: "→ ~/Downloads", onSelect: () => a.download(entries) },
      { kind: "item", label: "Copy paths", onSelect: () => a.copyPaths(entries.map((e) => e.path)) },
      { kind: "separator" },
      { kind: "item", label: `Delete ${n} items`, danger: true, onSelect: () => a.remove(entries) },
    ];
  }
  const entry = entries[0]!;
  const create: MenuNode[] = [
    { kind: "item", label: "New file…", onSelect: () => a.newFile(entry.path) },
    { kind: "item", label: "New folder…", onSelect: () => a.newFolder(entry.path) },
  ];
  const copy: MenuNode = { kind: "item", label: "Copy path", onSelect: () => a.copyPaths([entry.path]) };
  if (isRoot) {
    return [
      ...create,
      { kind: "separator" },
      copy,
      { kind: "item", label: "Download folder", hint: "→ ~/Downloads", onSelect: () => a.download([entry]) },
    ];
  }
  const tail: MenuNode[] = [
    { kind: "separator" },
    copy,
    { kind: "item", label: entry.isDir ? "Download folder" : "Download", hint: "→ ~/Downloads", onSelect: () => a.download([entry]) },
    { kind: "separator" },
    { kind: "item", label: "Rename…", onSelect: () => a.rename(entry) },
    { kind: "item", label: "Delete", danger: true, onSelect: () => a.remove([entry]) },
  ];
  if (entry.isDir) {
    return [
      { kind: "item", label: "Open as root", hint: "start the tree here", onSelect: () => a.setRoot(entry) },
      ...create,
      ...tail,
    ];
  }
  return [
    { kind: "item", label: "Open", onSelect: () => a.open(entry) },
    { kind: "item", label: "Open in default app", onSelect: () => a.openDefault(entry) },
    ...tail,
  ];
}

/**
 * The explorer pane: a windowed render over the flat `visibleRows` projection
 * (DOM row count stays bounded by the viewport no matter how big the listing),
 * with a multi-select model, a pinned selectable root row, and keyboard nav.
 * Data rules live in the injected store; drag-drop in the parent coordinator.
 */
export function FileTree({
  store,
  dropDir,
  actions,
}: {
  store: FileTreeStore;
  dropDir?: string | null;
  actions?: FileActions;
}) {
  useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.version,
  );

  const [sel, setSel] = useState(EMPTY_SELECTION);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(FALLBACK_VIEWPORT);
  const [narrow, setNarrow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowH = narrow ? ROW_HEIGHT_TOUCH : ROW_HEIGHT;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setViewH(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = visibleRows(store);
  const selectable = rows
    .filter((r) => r.kind === "root" || r.kind === "entry")
    .map((r) => (r.kind === "root" ? r.path : (r as Extract<TreeRow, { kind: "entry" }>).entry.path));

  const rootPath = store.rootPath;
  const entryAt = (path: string): FileEntry | null => {
    if (path === rootPath) {
      const row = rows[0];
      return row?.kind === "root" ? { name: row.name, path, isDir: true, size: 0 } : null;
    }
    for (const row of rows) {
      if (row.kind === "entry" && row.entry.path === path) return row.entry;
    }
    return null;
  };

  const scrollRowIntoView = (index: number) => {
    const el = bodyRef.current;
    if (!el) return;
    const top = index * rowH;
    const bottom = top + rowH;
    const height = el.clientHeight || FALLBACK_VIEWPORT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + height) el.scrollTop = bottom - height;
    setScrollTop(el.scrollTop);
  };

  const selectWith = (e: React.MouseEvent, path: string): boolean => {
    if (e.metaKey || e.ctrlKey) {
      setSel((s) => toggle(s, path));
      return true;
    }
    if (e.shiftKey) {
      setSel((s) => rangeTo(s, selectable, path));
      return true;
    }
    return false;
  };

  const onRootClick = (e: React.MouseEvent, path: string) => {
    if (selectWith(e, path)) return;
    setSel((s) => (s.paths.size === 1 && s.paths.has(path) ? clearSelection() : click(s, path)));
  };

  const onEntryClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (selectWith(e, entry.path)) return;
    setSel((s) => click(s, entry.path));
    if (entry.isDir) store.toggle(entry);
    else actions?.open(entry);
  };

  const onRowMenu = (target: FileEntry, e: React.MouseEvent) => {
    if (!actions) return;
    e.preventDefault();
    let entries: FileEntry[];
    if (sel.paths.has(target.path) && sel.paths.size > 1) {
      // Bulk actions never include the root row — deleting the tree's own
      // root out of a sweep would be a disaster, not a convenience.
      entries = selectable
        .filter((p) => sel.paths.has(p) && p !== rootPath)
        .map(entryAt)
        .filter((x): x is FileEntry => x !== null);
    } else {
      setSel((s) => click(s, target.path));
      entries = [target];
    }
    setMenu({ x: e.clientX, y: e.clientY, entries });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setSel(clearSelection());
      return;
    }
    const idx = sel.focus ? selectable.indexOf(sel.focus) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? Math.min(selectable.length - 1, idx + 1)
          : Math.max(0, idx <= 0 ? 0 : idx - 1);
      const path = selectable[next];
      if (path === undefined) return;
      setSel((s) => (e.shiftKey ? rangeTo(s, selectable, path) : click(s, path)));
      scrollRowIntoView(next);
      return;
    }
    const focused = sel.focus ? entryAt(sel.focus) : null;
    if (!focused) return;
    const isRoot = focused.path === rootPath;
    if (e.key === "ArrowRight" && focused.isDir && !isRoot && !store.isExpanded(focused.path)) {
      e.preventDefault();
      store.toggle(focused);
    } else if (e.key === "ArrowLeft" && focused.isDir && !isRoot && store.isExpanded(focused.path)) {
      e.preventDefault();
      store.toggle(focused);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isRoot) return;
      if (focused.isDir) store.toggle(focused);
      else actions?.open(focused);
    }
  };

  /** Where New file / New folder land: the single selected folder, a selected
   *  file's parent, or the root. */
  const creationDir = (): string | null => {
    if (sel.paths.size === 1) {
      const only = entryAt([...sel.paths][0]!);
      if (only) return only.isDir ? only.path : parentDir(only.path);
    }
    return rootPath;
  };

  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + OVERSCAN);
  const rootIsTarget = dropDir != null && dropDir === rootPath;

  const renderRow = (row: TreeRow) => {
    switch (row.kind) {
      case "root": {
        const selected = sel.paths.has(row.path);
        return (
          <button
            key="__root"
            type="button"
            className={`file-tree__row file-tree__row--root${selected ? " file-tree__row--selected" : ""}${sel.focus === row.path ? " file-tree__row--focus" : ""}${rootIsTarget ? " file-tree__row--drop" : ""}`}
            onClick={(e) => onRootClick(e, row.path)}
            onContextMenu={(e) => {
              const entry = entryAt(row.path);
              if (entry) onRowMenu(entry, e);
            }}
            data-path={row.path}
            data-dir="true"
            data-testid="root-row"
          >
            <span className="file-tree__twist">
              <Folder size={13} />
            </span>
            <span className="file-tree__name">{row.name}</span>
            <span className="file-tree__rootpath">{row.path}</span>
          </button>
        );
      }
      case "entry": {
        const { entry, depth } = row;
        const deleting = store.isDeleting(entry.path);
        const selected = sel.paths.has(entry.path);
        return (
          <button
            key={entry.path}
            type="button"
            className={`file-tree__row${dropDir === entry.path ? " file-tree__row--drop" : ""}${selected ? " file-tree__row--selected" : ""}${sel.focus === entry.path ? " file-tree__row--focus" : ""}${deleting ? " file-tree__row--deleting" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={(e) => !deleting && onEntryClick(e, entry)}
            disabled={deleting}
            aria-busy={deleting || undefined}
            onContextMenu={!deleting ? (e) => onRowMenu(entry, e) : undefined}
            data-path={entry.path}
            data-dir={entry.isDir}
          >
            <span className="file-tree__twist">
              {deleting ? (
                <span className="file-tree__spinner" aria-hidden="true" />
              ) : entry.isDir ? (
                <Folder size={13} />
              ) : null}
            </span>
            <span className="file-tree__name">{entry.name}</span>
            {deleting && <span className="file-tree__deleting">deleting…</span>}
          </button>
        );
      }
      case "skeleton":
        return (
          <div key={`s:${row.key}`} className="file-tree__rowskel" aria-hidden="true" style={{ paddingLeft: 8 + row.depth * 14 }}>
            <div className="file-tree__skel" style={{ width: "60%" }} />
          </div>
        );
      case "error":
        return (
          <p key={`e:${row.key}`} className="file-tree__note file-tree__note--error file-tree__note--row" style={{ paddingLeft: 8 + row.depth * 14 }}>
            {row.message}
          </p>
        );
      case "empty":
        return (
          <p key={`m:${row.key}`} className="file-tree__note file-tree__note--row" style={{ paddingLeft: 8 + row.depth * 14 }}>
            Empty
          </p>
        );
      case "truncated":
        return row.more ? (
          <button
            key={`t:${row.key}`}
            type="button"
            className="file-tree__note file-tree__note--row file-tree__more"
            style={{ paddingLeft: 8 + row.depth * 14 }}
            data-testid="truncated-row"
            onClick={() => store.loadMore(row.key)}
          >
            … show more
          </button>
        ) : (
          <p key={`t:${row.key}`} className="file-tree__note file-tree__note--row file-tree__more" style={{ paddingLeft: 8 + row.depth * 14 }} data-testid="truncated-row">
            … more — open to load
          </p>
        );
    }
  };

  return (
    <div
      className={`file-tree${rootIsTarget ? " file-tree--dropping" : ""}`}
      data-testid="file-tree"
    >
      <header className="file-tree__bar">
        <span className="file-tree__root">Files</span>
        <span className="file-tree__actions">
          {actions && rootPath && rootPath !== "/" && (
            <button
              type="button"
              className="file-tree__refresh"
              onClick={() => actions.climbRoot()}
              aria-label="Up one level"
              title="Up one level"
            >
              ↑
            </button>
          )}
          {actions && rootPath && (
            <>
              <button
                type="button"
                className="file-tree__refresh"
                onClick={() => {
                  const dir = creationDir();
                  if (dir) actions.newFile(dir);
                }}
                aria-label="New file"
                title="New file in the selected folder"
              >
                ＋
              </button>
              <button
                type="button"
                className="file-tree__refresh"
                onClick={() => {
                  const dir = creationDir();
                  if (dir) actions.newFolder(dir);
                }}
                aria-label="New folder"
                title="New folder in the selected folder"
              >
                ⊞
              </button>
            </>
          )}
          <button
            type="button"
            className={`file-tree__refresh${store.busy ? " file-tree__refresh--busy" : ""}`}
            onClick={() => store.refresh()}
            aria-label="Refresh"
          >
            ↻
          </button>
        </span>
      </header>
      <div
        className="file-tree__body"
        ref={bodyRef}
        tabIndex={0}
        role="tree"
        aria-multiselectable="true"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        {store.rootError ? (
          <p className="file-tree__note file-tree__note--error">{store.rootError}</p>
        ) : rootPath === null ? (
          <Skeleton />
        ) : (
          <>
            <div style={{ height: start * rowH }} aria-hidden="true" />
            {rows.slice(start, end).map(renderRow)}
            <div style={{ height: (rows.length - end) * rowH }} aria-hidden="true" />
          </>
        )}
      </div>
      {menu && actions && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={fileMenuItems(menu.entries, actions, menu.entries[0]?.path === rootPath)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="file-tree__skeleton" aria-hidden="true">
      {[68, 52, 60, 44].map((w, i) => (
        <div key={i} className="file-tree__skel" style={{ marginLeft: 10, width: `${w}%` }} />
      ))}
    </div>
  );
}
