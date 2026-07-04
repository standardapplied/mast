import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight } from "../components/icons";

/**
 * A lazy file tree over a project container's filesystem, backed by SFTP
 * (`fs_list`) on the same in-process session the terminal uses. Dropping OS
 * files onto it uploads them into the current directory (`fs_upload`). The fs
 * seam is injectable so the tree logic is testable without Tauri.
 */

export type FileEntry = { name: string; path: string; isDir: boolean; size: number };
export type FsListing = { path: string; entries: FileEntry[] };

export type FsApi = {
  list: (path: string | null) => Promise<FsListing>;
  upload: (remoteDir: string, paths: string[]) => Promise<string[]>;
};

function tauriFs(target: string): FsApi {
  return {
    list: (path) => invoke<FsListing>("fs_list", { target, path }),
    upload: (remoteDir, paths) =>
      invoke<string[]>("fs_upload", { target, remoteDir, localPaths: paths }),
  };
}

type NodeState = FsListing | "loading" | { error: string };

export function FileTree({
  target,
  fs,
  onToast,
}: {
  target: string;
  /** Override the SFTP seam (tests); defaults to the Tauri `invoke` bridge. */
  fs?: FsApi;
  onToast?: (message: string, ok: boolean) => void;
}) {
  const api = useRef(fs ?? tauriFs(target)).current;
  const treeRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<NodeState>("loading");
  // Directory listings keyed by absolute path; presence = expanded.
  const [open, setOpen] = useState<Record<string, NodeState>>({});
  const [dropping, setDropping] = useState(false);

  const loadRoot = useCallback(() => {
    setRoot("loading");
    api
      .list(null)
      .then((listing) => setRoot(listing))
      .catch((e) => setRoot({ error: String(e) }));
  }, [api]);

  useEffect(loadRoot, [loadRoot]);

  const rootDir = typeof root === "object" && "path" in root ? root.path : null;

  const toggle = (entry: FileEntry) => {
    setOpen((prev) => {
      if (prev[entry.path]) {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      }
      return { ...prev, [entry.path]: "loading" };
    });
    if (open[entry.path]) return; // was open → collapsed above
    api
      .list(entry.path)
      .then((listing) => setOpen((prev) => (prev[entry.path] ? { ...prev, [entry.path]: listing } : prev)))
      .catch((e) => setOpen((prev) => (prev[entry.path] ? { ...prev, [entry.path]: { error: String(e) } } : prev)));
  };

  const upload = useCallback(
    async (paths: string[]) => {
      if (!rootDir || paths.length === 0) return;
      try {
        const landed = await api.upload(rootDir, paths);
        onToast?.(`Uploaded ${landed.length} file${landed.length === 1 ? "" : "s"} to ${rootDir}`, true);
        loadRoot();
      } catch (e) {
        onToast?.(`Upload failed: ${e}`, false);
      }
    },
    [api, rootDir, onToast, loadRoot],
  );

  // Native OS file drop (Tauri gives real paths, not File objects). Guarded so
  // the tree still mounts outside a Tauri webview (tests, browser preview).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          // The drop event is window-global; ignore it unless this tree is the
          // visible view (offsetParent is null when a `display:none` ancestor —
          // e.g. the Board tab — hides it), so a drop on the board can't upload.
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
        .catch(() => {
          /* not in a Tauri webview */
        });
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
        <button type="button" className="file-tree__refresh" onClick={loadRoot} aria-label="Refresh">
          ↻
        </button>
      </header>
      <div className="file-tree__body">
        <TreeLevel node={root} open={open} depth={0} onToggle={toggle} />
      </div>
    </div>
  );
}

function TreeLevel({
  node,
  open,
  depth,
  onToggle,
}: {
  node: NodeState;
  open: Record<string, NodeState>;
  depth: number;
  onToggle: (entry: FileEntry) => void;
}) {
  if (node === "loading") return <p className="file-tree__note">Loading…</p>;
  if ("error" in node) return <p className="file-tree__note file-tree__note--error">{node.error}</p>;
  if (node.entries.length === 0) return <p className="file-tree__note">Empty</p>;

  return (
    <ul className="file-tree__list">
      {node.entries.map((entry) => {
        const child = open[entry.path];
        return (
          <li key={entry.path}>
            <button
              type="button"
              className="file-tree__row"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => entry.isDir && onToggle(entry)}
              data-dir={entry.isDir}
            >
              <span className="file-tree__twist">
                {entry.isDir ? child ? <CaretDown size={12} /> : <CaretRight size={12} /> : null}
              </span>
              <span className="file-tree__name">{entry.name}</span>
            </button>
            {entry.isDir && child && (
              <TreeLevel node={child} open={open} depth={depth + 1} onToggle={onToggle} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
