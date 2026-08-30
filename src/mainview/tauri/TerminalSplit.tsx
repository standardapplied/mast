import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "../components/Dialog";
import { PanelRight } from "../components/icons";
import { Tooltip } from "../components/Tooltip";
import { Splitter } from "../components/Splitter";
import { useToast } from "../components/Toast";
import { ToggleButton } from "../components/ToggleButton";
import { Button } from "../components/ui";
import { classifyDrop, parentDir, shellQuote, type DropTarget } from "./dropTarget";
import { FileTree, type FileActions } from "./FileTree";
import { FileTreeStore, type FileEntry, type FsApi } from "./fileTreeStore";
import { PromptDialog } from "./PromptDialog";
import type { TerminalHandle } from "./SessionTerminalPane";
import { duplicateDownloadName } from "./transfers";
import { TransfersTray } from "./TransfersTray";
import { ViewerPane } from "./ViewerPane";
import { ViewerStore, type ViewerFs } from "./viewerStore";
import {
  loadTreeCollapsed,
  loadWidths,
  PANE_LIMITS,
  saveTreeCollapsed,
  saveWidths,
  type PaneWidths,
} from "./workbenchLayout";

/**
 * A project's workbench: terminal | file viewer/editor | explorer, one
 * drag-drop coordinator, and the file operations (open, save, download,
 * rename, create, delete). Drops route by cursor position; transfers stream
 * to the tray; mutations revalidate the affected directories so the tree
 * stays truthful. ≤900px collapses to a single pane behind a segmented flip.
 */

function tauriFs(target: string): FsApi {
  return { listDeep: (path, after, depth) => invoke("fs_list_deep", { target, path, after, depth }) };
}

function tauriViewerFs(target: string): ViewerFs {
  return {
    stat: (path) => invoke("fs_stat", { target, path }),
    read: async (path) => new Uint8Array(await invoke<number[]>("fs_read", { target, path })),
    write: (path, bytes) => invoke("fs_write", { target, path, contents: Array.from(bytes) }),
    compareAndWrite: (path, expected, bytes) =>
      invoke("fs_write_checked", {
        target,
        path,
        expected: Array.from(expected),
        contents: Array.from(bytes),
      }),
  };
}

const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

type Prompt =
  | { mode: "rename"; entry: FileEntry }
  | { mode: "mkdir"; dir: string }
  | { mode: "newfile"; dir: string };

type MobilePane = "terminal" | "editor" | "files";

/** A destructive viewer transition awaiting the discard confirmation. */
type PendingViewerAction = { kind: "open"; entry: FileEntry } | { kind: "close" };

export function TerminalSplit({
  target,
  active,
  terminal,
}: {
  target: string;
  active?: boolean;
  /** Renders the terminal pillar (the durable multi-pane workspace). */
  terminal: (ref: React.Ref<TerminalHandle>) => React.ReactNode;
}) {
  // Created once for this mounted project (keyed by target upstream). Not
  // disposed on unmount: the listeners unsubscribe themselves and the store is
  // GC'd — and an irreversible dispose() would be re-run by React StrictMode's
  // mount→unmount→remount, permanently killing a live store.
  const rootKey = `mast.fileroot.${target}`;
  const [store] = useState(() => new FileTreeStore(tauriFs(target)));
  const [viewer] = useState(
    () =>
      new ViewerStore(tauriViewerFs(target), (url) => {
        void invoke("open_url", { url }).catch(() => {});
      }),
  );
  useEffect(() => {
    void store.loadRoot(localStorage.getItem(rootKey));
  }, [store, rootKey]);
  useSyncExternalStore(
    useCallback((cb) => viewer.subscribe(cb), [viewer]),
    () => viewer.version,
  );

  const { showToast } = useToast();
  const toast = (message: string, ok: boolean) => showToast(ok ? "success" : "error", message);

  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalHandle>(null);
  const [widths, setWidths] = useState<PaneWidths>(() => loadWidths(localStorage, target));
  const [treeCollapsed, setTreeCollapsed] = useState(() => loadTreeCollapsed(localStorage, target));
  const setTreeCollapsedPersistent = (collapsed: boolean) => {
    setTreeCollapsed(collapsed);
    saveTreeCollapsed(localStorage, target, collapsed);
  };
  const [mobilePane, setMobilePane] = useState<MobilePane>("terminal");
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDel, setConfirmDel] = useState<FileEntry[] | null>(null);
  const [pendingViewer, setPendingViewer] = useState<PendingViewerAction | null>(null);

  // A splitter drag resizes the terminal without a window resize; refit the VT
  // once the drag settles so the PTY geometry never sticks at a stale size.
  const refitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefit = () => {
    clearTimeout(refitTimer.current);
    refitTimer.current = setTimeout(() => termRef.current?.refit(), 120);
  };
  useEffect(() => () => clearTimeout(refitTimer.current), []);

  const setPane = (pane: keyof PaneWidths) => (width: number) => {
    setWidths((w) => ({ ...w, [pane]: width }));
    scheduleRefit();
  };
  const commitPane = (pane: keyof PaneWidths) => (width: number) => {
    setWidths((w) => {
      const next = { ...w, [pane]: width };
      saveWidths(localStorage, target, next);
      return next;
    });
    scheduleRefit();
  };

  const transfer = () => crypto.randomUUID();

  const openInViewer = useCallback(
    (entry: FileEntry) => {
      const current = viewer.state;
      // Re-clicking the open file must never reload it from disk — that would
      // silently drop unsaved edits.
      if (current.phase === "text" && current.entry.path === entry.path) {
        setMobilePane("editor");
        return;
      }
      if (viewer.isDirty) {
        setPendingViewer({ kind: "open", entry });
        return;
      }
      setMobilePane("editor");
      void viewer.open(entry);
    },
    [viewer],
  );

  const closeViewer = () => {
    viewer.close();
    setMobilePane((p) => (p === "editor" ? "terminal" : p));
  };

  const requestCloseViewer = () => {
    if (viewer.isDirty) {
      setPendingViewer({ kind: "close" });
      return;
    }
    closeViewer();
  };

  const uploadInto = useCallback(
    async (dir: string, paths: string[]): Promise<string[] | null> => {
      try {
        const landed = await invoke<string[]>("fs_upload", {
          target,
          remoteDir: dir,
          localPaths: paths,
          transferId: transfer(),
        });
        store.revalidate(dir);
        return landed;
      } catch {
        return null; // the tray surfaces the failure
      }
    },
    [target, store],
  );

  const onDrop = useCallback(
    async (tgt: DropTarget, paths: string[]) => {
      if (paths.length === 0) return;
      if (tgt.kind === "tree") {
        if (await uploadInto(tgt.dir, paths)) store.reveal(tgt.dir);
      } else if (tgt.kind === "terminal" && store.rootPath) {
        const landed = await uploadInto(store.rootPath, paths);
        if (landed?.length) termRef.current?.paste(`${landed.map(shellQuote).join(" ")} `);
      }
    },
    [store, uploadInto],
  );

  const download = (entries: FileEntry[]) => {
    const dupe = duplicateDownloadName(entries.map((e) => e.name));
    if (dupe) {
      toast(`Two selected items are named "${dupe}" — download them separately`, false);
      return;
    }
    void invoke("fs_download", {
      target,
      remotePaths: entries.map((e) => e.path),
      localDir: null,
      transferId: transfer(),
    }).catch(() => {});
  };

  const actions: FileActions = {
    open: openInViewer,
    openDefault: (e) =>
      void invoke("fs_open", { target, remotePath: e.path, transferId: transfer() }).catch(() => {}),
    download,
    remove: (entries) => setConfirmDel(entries),
    rename: (e) => setPrompt({ mode: "rename", entry: e }),
    newFolder: (dir) => setPrompt({ mode: "mkdir", dir }),
    newFile: (dir) => setPrompt({ mode: "newfile", dir }),
    setRoot: (e) => {
      localStorage.setItem(rootKey, e.path); // remember this project's root
      store.setRoot(e.path);
    },
    climbRoot: () => {
      const current = store.rootPath;
      if (!current || current === "/") return;
      const up = parentDir(current);
      localStorage.setItem(rootKey, up);
      store.setRoot(up);
    },
    copyPaths: (paths) => {
      void navigator.clipboard.writeText(paths.join("\n")).then(
        () => toast(paths.length > 1 ? `${paths.length} paths copied` : "Path copied", true),
        () => toast("Couldn’t copy path", false),
      );
    },
  };

  const doRename = async (entry: FileEntry, name: string) => {
    setPrompt(null);
    // A rename under the viewer's open file would leave its saves targeting
    // the old path — and the conflict-dialog Overwrite would recreate it.
    if (viewer.viewsPath(entry.path)) {
      toast(`Close the open file in the viewer before renaming ${entry.name}`, false);
      return;
    }
    const dir = parentDir(entry.path);
    try {
      await invoke("fs_rename", { target, from: entry.path, to: joinRemote(dir, name) });
      store.revalidate(dir);
      toast(`Renamed to ${name}`, true);
    } catch (e) {
      toast(`Rename failed: ${e}`, false);
    }
  };

  const doMkdir = async (dir: string, name: string) => {
    setPrompt(null);
    try {
      await invoke("fs_mkdir", { target, path: joinRemote(dir, name) });
      store.reveal(dir);
      store.revalidate(dir);
      toast(`Created ${name}`, true);
    } catch (e) {
      toast(`New folder failed: ${e}`, false);
    }
  };

  const doNewFile = async (dir: string, name: string) => {
    setPrompt(null);
    const path = joinRemote(dir, name);
    try {
      // Atomic create-if-absent (CREATE|EXCLUDE): an existing file fails the
      // call instead of being truncated, with no stat-then-write race.
      await invoke("fs_create_file", { target, path });
      store.reveal(dir);
      store.revalidate(dir);
      toast(`Created ${name}`, true);
      openInViewer({ name, path, isDir: false, size: 0 });
    } catch (e) {
      toast(`New file failed: ${e}`, false);
    }
  };

  const doDelete = async (entries: FileEntry[]) => {
    setConfirmDel(null);
    const dirs = new Set(entries.map((e) => parentDir(e.path)));
    // Lock the nodes up front; the tray (fed by the Rust `transfer` event) owns
    // ALL delete feedback — live "Deleting…", "Removed", and failure detail —
    // exactly like uploads, so completion never announces itself twice.
    const deleted = (
      await Promise.all(
        entries.map(async (entry) => {
          store.beginDelete(entry.path);
          try {
            await invoke("fs_delete", { target, path: entry.path, transferId: transfer() });
            return entry;
          } catch {
            // Refresh the node itself so any partial deletion is reflected honestly.
            store.revalidate(entry.path);
            return null;
          } finally {
            store.endDelete(entry.path);
          }
        }),
      )
    ).filter((entry): entry is FileEntry => entry !== null);
    for (const dir of dirs) store.revalidate(dir);
    // Close the editor only over files actually removed — a failed delete of a
    // dirty file must keep its unsaved buffer alive for retry.
    const open = viewer.state.phase !== "closed" ? viewer.state.entry.path : null;
    if (open && deleted.some((e) => open === e.path || open.startsWith(`${e.path}/`))) {
      closeViewer();
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // Tauri's drag-drop position is physical pixels on some platforms/versions
    // and logical (CSS) on others; elementFromPoint wants CSS pixels. Divide by
    // the device ratio only when the value is clearly physical (past the CSS
    // viewport) — otherwise a logical coord gets halved on a Retina display and
    // every drop lands in the left (terminal) pane.
    const toCss = (x: number, y: number): [number, number] => {
      const ratio = window.devicePixelRatio || 1;
      const cx = x > window.innerWidth ? x / ratio : x;
      const cy = y > window.innerHeight ? y / ratio : y;
      return [cx, cy];
    };
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (!rootRef.current || rootRef.current.offsetParent === null) return; // visible view only
          const p = event.payload;
          if (p.type === "leave") return setDrop(null);
          const el = document.elementFromPoint(...toCss(p.position.x, p.position.y));
          const tgt = classifyDrop(el, store.rootPath);
          if (p.type === "over") setDrop(tgt);
          else if (p.type === "drop") {
            setDrop(null);
            void onDrop(tgt, p.paths);
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
  }, [store, onDrop]);

  const terminalTargeted = drop?.kind === "terminal";
  const dropDir = drop?.kind === "tree" ? drop.dir : null;
  const viewerOpen = viewer.isOpen;

  const flipOptions = [
    { value: "terminal", label: "Terminal" },
    ...(viewerOpen ? [{ value: "editor", label: "Editor" }] : []),
    { value: "files", label: "Files" },
  ];

  return (
    <div
      className={`term-split${treeCollapsed ? " term-split--treecollapsed" : ""}`}
      ref={rootRef}
      data-mobile={mobilePane}
      style={
        {
          "--tree-w": `${widths.tree}px`,
          "--viewer-w": `${widths.viewer}px`,
        } as React.CSSProperties
      }
    >
      <div className="term-split__flip">
        <ToggleButton
          options={flipOptions}
          value={viewerOpen || mobilePane !== "editor" ? mobilePane : "terminal"}
          onChange={(v) => setMobilePane(v as MobilePane)}
        />
      </div>
      <div className="term-split__panes">
        <div className={`term-split__main${terminalTargeted ? " term-split__main--drop" : ""}`}>
          {terminal(termRef)}
        </div>
        {viewerOpen && (
          <>
            <Splitter
              value={widths.viewer}
              min={PANE_LIMITS.viewer.min}
              max={PANE_LIMITS.viewer.max}
              controls="after"
              onChange={setPane("viewer")}
              onDragEnd={commitPane("viewer")}
              ariaLabel="Resize viewer"
            />
            <ViewerPane
              store={viewer}
              onClose={requestCloseViewer}
              onOpenDefault={actions.openDefault}
              onDownload={(e) => download([e])}
              onToast={toast}
            />
          </>
        )}
        {treeCollapsed && (
          <div className="term-split__treestub">
            <Tooltip content="Show the file tree" side="left">
              <button
                type="button"
                className="term-split__treestub-btn"
                aria-label="Show the file tree"
                onClick={() => setTreeCollapsedPersistent(false)}
              >
                <PanelRight size={15} />
              </button>
            </Tooltip>
          </div>
        )}
        {!treeCollapsed && (
          <Splitter
            value={widths.tree}
            min={PANE_LIMITS.tree.min}
            max={PANE_LIMITS.tree.max}
            controls="after"
            onChange={setPane("tree")}
            onDragEnd={commitPane("tree")}
            ariaLabel="Resize file tree"
          />
        )}
        <FileTree
          store={store}
          dropDir={dropDir}
          actions={actions}
          onCollapse={() => setTreeCollapsedPersistent(true)}
        />
      </div>
      <TransfersTray />

      {prompt?.mode === "rename" && (
        <PromptDialog
          title="Rename"
          label="New name"
          initial={prompt.entry.name}
          confirmLabel="Rename"
          onConfirm={(v) => void doRename(prompt.entry, v)}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt?.mode === "mkdir" && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          confirmLabel="Create"
          onConfirm={(v) => void doMkdir(prompt.dir, v)}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt?.mode === "newfile" && (
        <PromptDialog
          title="New file"
          label="File name"
          confirmLabel="Create"
          onConfirm={(v) => void doNewFile(prompt.dir, v)}
          onClose={() => setPrompt(null)}
        />
      )}
      {confirmDel && (
        <Dialog
          isOpen
          onClose={() => setConfirmDel(null)}
          title={
            confirmDel.length === 1 ? `Delete ${confirmDel[0]!.name}?` : `Delete ${confirmDel.length} items?`
          }
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDel(null)}>
                Cancel
              </Button>
              <Button className="btn-danger" onClick={() => void doDelete(confirmDel)}>
                Delete
              </Button>
            </>
          }
        >
          <p>
            {confirmDel.length === 1
              ? confirmDel[0]!.isDir
                ? "This folder and everything in it will be permanently deleted."
                : "This file will be permanently deleted."
              : `${confirmDel.length} items — including everything inside any folders — will be permanently deleted.`}
          </p>
        </Dialog>
      )}
      {pendingViewer && (
        <Dialog
          isOpen
          onClose={() => setPendingViewer(null)}
          title="Discard unsaved changes?"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setPendingViewer(null)}>
                Cancel
              </Button>
              <Button
                className="btn-danger"
                onClick={() => {
                  const action = pendingViewer;
                  setPendingViewer(null);
                  if (action.kind === "close") {
                    closeViewer();
                    return;
                  }
                  setMobilePane("editor");
                  void viewer.open(action.entry);
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p>
            The open file has unsaved changes. Discard them
            {pendingViewer.kind === "open" ? ` and open ${pendingViewer.entry.name}?` : " and close the editor?"}
          </p>
        </Dialog>
      )}
    </div>
  );
}
