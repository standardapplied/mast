import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui";
import { classifyDrop, parentDir, shellQuote, type DropTarget } from "./dropTarget";
import { EditorDialog } from "./EditorDialog";
import { FileTree, type FileActions } from "./FileTree";
import { FileTreeStore, type FileEntry, type FsApi } from "./fileTreeStore";
import { PromptDialog } from "./PromptDialog";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { TransfersTray } from "./TransfersTray";

/**
 * A project's workspace: terminal + file tree + the ONE drag-drop coordinator,
 * plus the file operations (edit, open, download, rename, new folder, delete).
 * Drops route by cursor position; transfers stream to the tray; mutations
 * revalidate the affected directory so the tree stays truthful.
 */

function tauriFs(target: string): FsApi {
  return { list: (path) => invoke("fs_list", { target, path }) };
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

type Prompt = { mode: "rename"; entry: FileEntry } | { mode: "mkdir"; dir: string };

export function TerminalSplit({
  target,
  label,
  onBack,
}: {
  target: string;
  label: string;
  onBack: () => void;
}) {
  const [store] = useState(() => new FileTreeStore(tauriFs(target)));
  useEffect(() => () => store.dispose(), [store]);

  const { showToast } = useToast();
  const toast = (message: string, ok: boolean) => showToast(ok ? "success" : "error", message);

  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalHandle>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [editor, setEditor] = useState<FileEntry | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDel, setConfirmDel] = useState<FileEntry | null>(null);

  const transfer = () => crypto.randomUUID();

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

  const actions: FileActions = {
    edit: (e) => setEditor(e),
    open: (e) =>
      void invoke("fs_open", { target, remotePath: e.path, transferId: transfer() }).catch(() => {}),
    download: (e) =>
      void invoke("fs_download", {
        target,
        remotePaths: [e.path],
        localDir: null,
        transferId: transfer(),
      }).catch(() => {}),
    rename: (e) => setPrompt({ mode: "rename", entry: e }),
    remove: (e) => setConfirmDel(e),
    newFolder: (dir) => setPrompt({ mode: "mkdir", dir }),
  };

  const doRename = async (entry: FileEntry, name: string) => {
    setPrompt(null);
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

  const doDelete = async (entry: FileEntry) => {
    setConfirmDel(null);
    try {
      await invoke("fs_delete", { target, path: entry.path });
      store.revalidate(parentDir(entry.path));
      toast(`Deleted ${entry.name}`, true);
    } catch (e) {
      toast(`Delete failed: ${e}`, false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const toCss = (x: number, y: number): [number, number] => {
      const ratio = window.devicePixelRatio || 1;
      return [x / ratio, y / ratio];
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

  return (
    <div className="term-split" ref={rootRef}>
      <div className={`term-split__main${terminalTargeted ? " term-split__main--drop" : ""}`}>
        <TerminalPane ref={termRef} target={target} label={label} onBack={onBack} />
      </div>
      <FileTree store={store} dropDir={dropDir} actions={actions} />
      <TransfersTray />

      {editor && (
        <EditorDialog target={target} entry={editor} onClose={() => setEditor(null)} onToast={toast} />
      )}
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
      {confirmDel && (
        <Dialog
          isOpen
          onClose={() => setConfirmDel(null)}
          title={`Delete ${confirmDel.name}?`}
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
            {confirmDel.isDir
              ? "This folder and everything in it will be permanently deleted."
              : "This file will be permanently deleted."}
          </p>
        </Dialog>
      )}
    </div>
  );
}
