import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CaretDown, CaretRight } from "../components/icons";
import { FileTreeStore, type DirState, type FileEntry, type FsApi } from "./fileTreeStore";

export type { FileEntry, FsApi, FsListing } from "./fileTreeStore";

/**
 * A lazy file tree over a project container's filesystem (SFTP `fs_list`), with
 * caching, background revalidation, and next-level prefetch — all in
 * `FileTreeStore` so the rules are tested independently. Dropping OS files
 * uploads them into the current directory. The fs seam is injectable for tests.
 */

function tauriFs(target: string): FsApi {
  return {
    list: (path) => invoke("fs_list", { target, path }),
    upload: (remoteDir, paths) => invoke("fs_upload", { target, remoteDir, localPaths: paths }),
  };
}

export function FileTree({
  target,
  fs,
  onToast,
}: {
  target: string;
  fs?: FsApi;
  onToast?: (message: string, ok: boolean) => void;
}) {
  const [store] = useState(() => new FileTreeStore(fs ?? tauriFs(target)));
  const treeRef = useRef<HTMLDivElement>(null);

  useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.version,
  );

  useEffect(() => {
    void store.loadRoot();
    return () => store.dispose();
  }, [store]);

  const upload = useCallback(
    async (paths: string[]) => {
      const dir = store.rootPath;
      if (!dir || paths.length === 0) return;
      try {
        const landed = await store.upload(dir, paths);
        onToast?.(`Uploaded ${landed.length} file${landed.length === 1 ? "" : "s"} to ${dir}`, true);
      } catch (e) {
        onToast?.(`Upload failed: ${e}`, false);
      }
    },
    [store, onToast],
  );

  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          // The drop event is window-global; ignore it unless this tree is the
          // visible view (offsetParent is null under a `display:none` ancestor,
          // e.g. the Board tab), so a drop elsewhere can't upload here.
          if (!treeRef.current || treeRef.current.offsetParent === null) return;
          const p = event.payload;
          if (p.type === "over") setDropping(true);
          else if (p.type === "leave") setDropping(false);
          else if (p.type === "drop") {
            setDropping(false);
            void upload(p.paths);
          }
        })
        .then((off) => {
          unlisten = off;
        })
        .catch(() => {});
    } catch {
      /* not in a Tauri webview */
    }
    return () => unlisten?.();
  }, [upload]);

  return (
    <div
      ref={treeRef}
      className={`file-tree${dropping ? " file-tree--dropping" : ""}`}
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
          <TreeLevel store={store} path={store.rootPath} depth={0} />
        )}
      </div>
    </div>
  );
}

function TreeLevel({ store, path, depth }: { store: FileTreeStore; path: string; depth: number }) {
  const node: DirState | undefined = store.dir(path);
  if (!node || node.status === "loading") return <Skeleton depth={depth} />;
  if (node.status === "error") {
    return <p className="file-tree__note file-tree__note--error">{node.error}</p>;
  }
  if (node.entries.length === 0) {
    return <p className="file-tree__note" style={{ paddingLeft: 8 + depth * 14 }}>Empty</p>;
  }
  return (
    <ul className="file-tree__list">
      {node.entries.map((entry) => (
        <li key={entry.path}>
          <Row entry={entry} depth={depth} expanded={store.isExpanded(entry.path)} onToggle={() => store.toggle(entry)} />
          {entry.isDir && store.isExpanded(entry.path) && (
            <TreeLevel store={store} path={entry.path} depth={depth + 1} />
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
  onToggle,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="file-tree__row"
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={onToggle}
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
