import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyDrop, shellQuote, type DropTarget } from "./dropTarget";
import { FileTree } from "./FileTree";
import { FileTreeStore, type FileEntry, type FsApi } from "./fileTreeStore";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { TransfersTray } from "./TransfersTray";

/**
 * A project's workspace: terminal + file tree + the ONE drag-drop coordinator.
 * A native file/folder drop routes by cursor position — into the tree directory
 * under it (upload + reveal), or onto the terminal (upload to the login dir +
 * inject the paths into the shell). Transfers stream progress to the tray.
 */

function tauriFs(target: string): FsApi {
  return { list: (path) => invoke("fs_list", { target, path }) };
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

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

  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalHandle>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const uploadInto = useCallback(
    async (dir: string, paths: string[]): Promise<boolean> => {
      try {
        await invoke("fs_upload", {
          target,
          remoteDir: dir,
          localPaths: paths,
          transferId: crypto.randomUUID(),
        });
        store.revalidate(dir);
        return true;
      } catch {
        return false; // the tray surfaces the failure
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
        const dir = store.rootPath;
        if (await uploadInto(dir, paths)) {
          const remotes = paths.map((p) => shellQuote(joinRemote(dir, baseName(p))));
          termRef.current?.paste(`${remotes.join(" ")} `);
        }
      }
    },
    [store, uploadInto],
  );

  const download = useCallback(
    (entry: FileEntry) => {
      void invoke("fs_download", {
        target,
        remotePaths: [entry.path],
        localDir: null,
        transferId: crypto.randomUUID(),
      }).catch(() => {});
    },
    [target],
  );

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
      <FileTree store={store} dropDir={dropDir} onDownload={download} />
      <TransfersTray />
    </div>
  );
}
