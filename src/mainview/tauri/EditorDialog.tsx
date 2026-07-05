import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { FileEntry } from "./fileTreeStore";

type Loaded = "loading" | "ready" | "binary" | { error: string };

/**
 * A light editor for a text file in a container: read over SFTP, edit, push
 * back (`fs_write`). Not an IDE — a quick review-time edit. Binary files are
 * refused (offer download instead).
 */
export function EditorDialog({
  target,
  entry,
  onClose,
  onToast,
}: {
  target: string;
  entry: FileEntry;
  onClose: () => void;
  onToast: (message: string, ok: boolean) => void;
}) {
  const [state, setState] = useState<Loaded>("loading");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<number[]>("fs_read", { target, path: entry.path })
      .then((bytes) => {
        if (!alive) return;
        const arr = new Uint8Array(bytes);
        if (arr.includes(0)) return setState("binary"); // NUL → binary
        setText(new TextDecoder("utf-8", { fatal: false }).decode(arr));
        setState("ready");
      })
      .catch((e) => alive && setState({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [target, entry.path]);

  const save = async () => {
    setSaving(true);
    try {
      await invoke("fs_write", {
        target,
        path: entry.path,
        contents: Array.from(new TextEncoder().encode(text)),
      });
      onToast(`Saved ${entry.name}`, true);
      onClose();
    } catch (e) {
      onToast(`Save failed: ${e}`, false);
      setSaving(false);
    }
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={entry.name}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={state !== "ready" || saving || !dirty} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {state === "loading" && <p className="editor__note">Loading…</p>}
      {state === "binary" && (
        <p className="editor__note">Binary file — can’t edit here. Download it instead.</p>
      )}
      {typeof state === "object" && (
        <p className="editor__note editor__note--error">{state.error}</p>
      )}
      {state === "ready" && (
        <textarea
          className="editor__area"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
        />
      )}
    </Dialog>
  );
}
