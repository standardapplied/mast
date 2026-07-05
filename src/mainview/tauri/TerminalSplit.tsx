import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toast";
import { classifyDrop, shellQuote, type DropTarget } from "./dropTarget";
import { FileTree } from "./FileTree";
import { FileTreeStore, type FsApi } from "./fileTreeStore";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";

/**
 * A project's workspace: the terminal + file tree, plus the ONE drag-drop
 * coordinator that routes a native file drop by cursor position — into the tree
 * directory under it (upload + reveal), or onto the terminal (upload to the
 * login dir + inject the paths into the shell). Keyed by target upstream, so
 * the store and terminal reset cleanly per project.
 */

function tauriFs(target: string): FsApi {
  return {
    list: (path) => invoke("fs_list", { target, path }),
    upload: (remoteDir, paths) => invoke("fs_upload", { target, remoteDir, localPaths: paths }),
  };
}

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
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<TerminalHandle>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);

  const uploadTo = useCallback(
    async (dir: string, paths: string[]): Promise<string[] | null> => {
      try {
        const landed = await store.upload(dir, paths);
        showToast("success", `Uploaded ${landed.length} file${landed.length === 1 ? "" : "s"} to ${dir}`);
        return landed;
      } catch (e) {
        showToast("error", `Upload failed: ${e}`);
        return null;
      }
    },
    [store, showToast],
  );

  const onDrop = useCallback(
    async (tgt: DropTarget, paths: string[]) => {
      if (paths.length === 0) return;
      if (tgt.kind === "tree") {
        if (await uploadTo(tgt.dir, paths)) store.reveal(tgt.dir);
      } else if (tgt.kind === "terminal" && store.rootPath) {
        const landed = await uploadTo(store.rootPath, paths);
        if (landed?.length) termRef.current?.paste(landed.map(shellQuote).join(" ") + " ");
      }
    },
    [store, uploadTo],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const cssPoint = (x: number, y: number): [number, number] => {
      const ratio = window.devicePixelRatio || 1;
      return [x / ratio, y / ratio];
    };
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          // Only when this split is the visible view (hidden on the Board tab).
          if (!rootRef.current || rootRef.current.offsetParent === null) return;
          const p = event.payload;
          if (p.type === "leave") return setDrop(null);
          const el = document.elementFromPoint(...cssPoint(p.position.x, p.position.y));
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
      <FileTree store={store} dropDir={dropDir} />
    </div>
  );
}
