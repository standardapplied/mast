import { useCallback, useState, useSyncExternalStore } from "react";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import { Folder } from "../components/icons";
import type { DirState, FileEntry, FileTreeStore } from "./fileTreeStore";

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? "/";

export type { FileEntry, FsApi, FsListing } from "./fileTreeStore";

type Menu = { x: number; y: number; entry: FileEntry };

export type FileActions = {
  edit: (entry: FileEntry) => void;
  open: (entry: FileEntry) => void;
  download: (entry: FileEntry) => void;
  rename: (entry: FileEntry) => void;
  remove: (entry: FileEntry) => void;
  newFolder: (parentDir: string) => void;
  setRoot: (entry: FileEntry) => void;
};

/** The right-click menu for an entry — files edit/open, dirs re-root/new folder. */
export function fileMenuItems(entry: FileEntry, a: FileActions): MenuNode[] {
  const tail: MenuNode[] = [
    { kind: "separator" },
    { kind: "item", label: entry.isDir ? "Download folder" : "Download", hint: "→ ~/Downloads", onSelect: () => a.download(entry) },
    { kind: "separator" },
    { kind: "item", label: "Rename…", onSelect: () => a.rename(entry) },
    { kind: "item", label: "Delete", danger: true, onSelect: () => a.remove(entry) },
  ];
  if (entry.isDir) {
    return [
      { kind: "item", label: "Open as root", hint: "start the tree here", onSelect: () => a.setRoot(entry) },
      { kind: "item", label: "New folder…", onSelect: () => a.newFolder(entry.path) },
      ...tail,
    ];
  }
  return [
    { kind: "item", label: "Edit", onSelect: () => a.edit(entry) },
    { kind: "item", label: "Open", hint: "default app", onSelect: () => a.open(entry) },
    ...tail,
  ];
}

/**
 * A lazy file tree, a pure view over an injected `FileTreeStore` (which owns the
 * caching / prefetch / revalidation rules). Drag-drop is handled by the parent
 * coordinator, which highlights the target directory via `dropDir`.
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

  const [menu, setMenu] = useState<Menu | null>(null);
  const onRowMenu = actions
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
        <span className="file-tree__root" title={store.rootPath ?? undefined}>
          <Folder size={13} />
          <span className="file-tree__rootname">
            {store.rootPath ? baseName(store.rootPath) : "Files"}
          </span>
        </span>
        <span className="file-tree__actions">
          {actions && store.rootPath && (
            <button
              type="button"
              className="file-tree__refresh"
              onClick={() => actions.newFolder(store.rootPath!)}
              aria-label="New folder"
            >
              ＋
            </button>
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
      <div className="file-tree__body">
        {store.rootError ? (
          <p className="file-tree__note file-tree__note--error">{store.rootError}</p>
        ) : store.rootPath === null ? (
          <Skeleton depth={0} />
        ) : (
          <TreeLevel store={store} path={store.rootPath} depth={0} dropDir={dropDir} onRowMenu={onRowMenu} />
        )}
      </div>
      {menu && actions && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={fileMenuItems(menu.entry, actions)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
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
  isDropTarget,
  onToggle,
  onRowMenu,
}: {
  entry: FileEntry;
  depth: number;
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
        {entry.isDir ? <Folder size={13} /> : null}
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
