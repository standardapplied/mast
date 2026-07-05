import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import { CaretDown, CaretRight } from "../components/icons";
import type { DirState, FileEntry, FileTreeStore } from "./fileTreeStore";

export type { FileEntry, FsApi, FsListing } from "./fileTreeStore";

type Menu = { x: number; y: number; entry: FileEntry };

/**
 * A lazy file tree, a pure view over an injected `FileTreeStore` (which owns the
 * caching / prefetch / revalidation rules). Drag-drop is handled by the parent
 * coordinator, which highlights the target directory via `dropDir`.
 */
export function FileTree({
  store,
  dropDir,
  onDownload,
}: {
  store: FileTreeStore;
  dropDir?: string | null;
  onDownload?: (entry: FileEntry) => void;
}) {
  useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.version,
  );
  useEffect(() => {
    void store.loadRoot();
  }, [store]);

  const [menu, setMenu] = useState<Menu | null>(null);
  const onRowMenu = onDownload
    ? (entry: FileEntry, e: React.MouseEvent) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, entry });
      }
    : undefined;

  const rootIsTarget = dropDir != null && dropDir === store.rootPath;

  return (
    <div
      className={`file-tree${rootIsTarget ? " file-tree--dropping" : ""}`}
      data-testid="file-tree"
    >
      <header className="file-tree__bar">
        <span className="file-tree__title">Files</span>
        <button
          type="button"
          className={`file-tree__refresh${store.busy ? " file-tree__refresh--busy" : ""}`}
          onClick={() => store.refresh()}
          aria-label="Refresh"
        >
          ↻
        </button>
      </header>
      <div className="file-tree__body">
        {store.rootError ? (
          <p className="file-tree__note file-tree__note--error">{store.rootError}</p>
        ) : store.rootPath === null ? (
          <Skeleton depth={0} />
        ) : (
          <TreeLevel store={store} path={store.rootPath} depth={0} dropDir={dropDir} onRowMenu={onRowMenu} />
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={downloadMenu(menu.entry, onDownload!)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function downloadMenu(entry: FileEntry, onDownload: (e: FileEntry) => void): MenuNode[] {
  return [
    {
      kind: "item",
      label: entry.isDir ? "Download folder" : "Download",
      hint: "→ ~/Downloads",
      onSelect: () => onDownload(entry),
    },
  ];
}

function TreeLevel({
  store,
  path,
  depth,
  dropDir,
  onRowMenu,
}: {
  store: FileTreeStore;
  path: string;
  depth: number;
  dropDir?: string | null;
  onRowMenu?: (entry: FileEntry, e: React.MouseEvent) => void;
}) {
  const node: DirState | undefined = store.dir(path);
  if (!node || node.status === "loading") return <Skeleton depth={depth} />;
  if (node.status === "error") {
    return <p className="file-tree__note file-tree__note--error">{node.error}</p>;
  }
  if (node.entries.length === 0) {
    return (
      <p className="file-tree__note" style={{ paddingLeft: 8 + depth * 14 }}>
        Empty
      </p>
    );
  }
  return (
    <ul className="file-tree__list">
      {node.entries.map((entry) => (
        <li key={entry.path}>
          <Row
            entry={entry}
            depth={depth}
            expanded={store.isExpanded(entry.path)}
            isDropTarget={dropDir === entry.path}
            onToggle={() => store.toggle(entry)}
            onRowMenu={onRowMenu}
          />
          {entry.isDir && store.isExpanded(entry.path) && (
            <TreeLevel store={store} path={entry.path} depth={depth + 1} dropDir={dropDir} onRowMenu={onRowMenu} />
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({
  entry,
  depth,
  expanded,
  isDropTarget,
  onToggle,
  onRowMenu,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  isDropTarget: boolean;
  onToggle: () => void;
  onRowMenu?: (entry: FileEntry, e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={`file-tree__row${isDropTarget ? " file-tree__row--drop" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={onToggle}
      onContextMenu={onRowMenu ? (e) => onRowMenu(entry, e) : undefined}
      data-path={entry.path}
      data-dir={entry.isDir}
    >
      <span className="file-tree__twist">
        {entry.isDir ? expanded ? <CaretDown size={12} /> : <CaretRight size={12} /> : null}
      </span>
      <span className="file-tree__name">{entry.name}</span>
    </button>
  );
}

function Skeleton({ depth }: { depth: number }) {
  return (
    <div className="file-tree__skeleton" aria-hidden="true">
      {[68, 52, 60, 44].map((w, i) => (
        <div key={i} className="file-tree__skel" style={{ marginLeft: 10 + depth * 14, width: `${w}%` }} />
      ))}
    </div>
  );
}
