import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "../components/Dialog";
import { Cross } from "../components/icons";
import { ToggleButton } from "../components/ToggleButton";
import { Button } from "../components/ui";
import { Markdown } from "../markdown";
import { loadCodeMirrorEditor, type EditorFactory, type EditorHandle } from "./editorSeam";
import type { FileEntry } from "./fileTreeStore";
import { humanBytes } from "./transfers";
import type { ViewerStore } from "./viewerStore";

/**
 * The middle workbench pane: a thin view over ViewerStore. Text mounts the
 * editor seam (CodeMirror, lazily); markdown adds Write/Preview; images and
 * PDFs render from blob URLs; everything else gets the metadata card with
 * open/download escapes. Saves flow back through the store's content guard.
 */

const MD_PANES = [
  { value: "write", label: "Write" },
  { value: "preview", label: "Preview" },
];

function blobUrl(bytes: Uint8Array, mime: string): string {
  try {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    return "";
  }
}

const FALLBACK_LABEL: Record<string, string> = {
  "too-large": "Too large to preview",
  binary: "Binary file — no inline preview",
  unknown: "No inline preview for this file",
  gpointer: "Google file",
  error: "Couldn’t load this file",
};

export function ViewerPane({
  store,
  editorFactory = loadCodeMirrorEditor,
  onClose,
  onOpenDefault,
  onDownload,
  onToast,
}: {
  store: ViewerStore;
  editorFactory?: EditorFactory;
  onClose: () => void;
  onOpenDefault: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onToast: (message: string, ok: boolean) => void;
}) {
  useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    () => store.version,
  );

  const state = store.state;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [mdPane, setMdPane] = useState("write");
  const [previewText, setPreviewText] = useState("");
  const [conflictText, setConflictText] = useState<string | null>(null);

  const textPath = state.phase === "text" ? state.entry.path : null;
  const textDoc = state.phase === "text" ? state.text : null;
  const textLanguage = state.phase === "text" ? state.language : null;

  const saveWith = useCallback(
    async (handle: EditorHandle, force: boolean) => {
      if (store.state.phase !== "text") return;
      const name = store.state.entry.name;
      const savedText = handle.getText();
      const result = await store.save(savedText, { force });
      if (result === "saved") {
        // Keystrokes that landed while the write was in flight were NOT
        // persisted — only reset the dirty baseline if nothing moved.
        if (handle.getText() === savedText) {
          handle.markSaved();
        } else {
          store.setDirty(true);
        }
        onToast(`Saved ${name}`, true);
      } else if (result === "conflict") {
        setConflictText(savedText);
      } else {
        onToast(`Save failed: ${name}`, false);
      }
    },
    [store, onToast],
  );

  useEffect(() => {
    if (textPath === null || textDoc === null || !hostRef.current) return;
    let alive = true;
    let handle: EditorHandle | null = null;
    setEditorReady(false);
    setMdPane("write");
    void editorFactory({
      parent: hostRef.current,
      doc: textDoc,
      language: textLanguage,
      onDirtyChange: (dirty) => store.setDirty(dirty),
      onSave: () => {
        if (handle) void saveWith(handle, false);
      },
    }).then((h) => {
      if (!alive) return h.destroy();
      handle = h;
      editorRef.current = h;
      setEditorReady(true);
      const line = store.takeRevealLine();
      if (line !== null) h.revealLine(line);
      h.focus();
    });
    return () => {
      alive = false;
      editorRef.current = null;
      handle?.destroy();
    };
    // The editor remounts per file, never per keystroke: only the path matters.
  }, [textPath, editorFactory, store]);

  const media = state.phase === "image" || state.phase === "pdf" ? state : null;
  const mediaUrl = useMemo(
    () => (media ? blobUrl(media.bytes, media.phase === "image" ? media.mime : "application/pdf") : ""),
    [media],
  );
  useEffect(() => {
    if (!mediaUrl) return;
    return () => URL.revokeObjectURL(mediaUrl);
  }, [mediaUrl]);

  if (state.phase === "closed") return null;
  const entry = state.entry;
  const showPreview = state.phase === "text" && state.markdown && mdPane === "preview";

  return (
    <section className="viewer" data-testid="viewer" aria-label={`Viewing ${entry.name}`}>
      <header className="viewer__bar">
        <span className="viewer__title" title={entry.path}>
          <span className="viewer__name">{entry.name}</span>
          {state.phase === "text" && state.dirty && (
            <span className="viewer__dirty" data-testid="viewer-dirty" title="Unsaved changes" />
          )}
        </span>
        {state.phase === "text" && state.markdown && (
          <ToggleButton
            className="viewer__mdtabs"
            options={MD_PANES}
            value={mdPane}
            onChange={(v) => {
              if (v === "preview") setPreviewText(editorRef.current?.getText() ?? state.text);
              setMdPane(v);
            }}
          />
        )}
        <button
          type="button"
          className="viewer__close"
          aria-label="Close viewer"
          onClick={onClose}
        >
          <Cross size={13} />
        </button>
      </header>

      <div className="viewer__body">
        {state.phase === "loading" && <p className="viewer__note">Loading…</p>}

        {state.phase === "text" && (
          <>
            <div
              ref={hostRef}
              className="viewer__editor"
              data-testid="viewer-editor"
              style={showPreview ? { display: "none" } : undefined}
            />
            {!editorReady && <p className="viewer__note">Opening editor…</p>}
            {showPreview && (
              <div className="viewer__preview" data-testid="viewer-preview">
                <Markdown source={previewText || "*Empty file.*"} />
              </div>
            )}
          </>
        )}

        {state.phase === "image" && (
          <div className="viewer__media">
            <img className="viewer__image" src={mediaUrl} alt={entry.name} data-testid="viewer-image" />
          </div>
        )}

        {state.phase === "pdf" && (
          <embed
            className="viewer__pdf"
            src={mediaUrl}
            type="application/pdf"
            data-testid="viewer-pdf"
          />
        )}

        {state.phase === "fallback" && (
          <div className="viewer__card" data-testid="viewer-fallback">
            <p className="viewer__card-name">{entry.name}</p>
            <p className="viewer__card-meta">
              {FALLBACK_LABEL[state.reason]}
              {state.size > 0 && ` · ${humanBytes(state.size)}`}
            </p>
            {state.detail && <p className="viewer__card-detail">{state.detail}</p>}
            <div className="viewer__card-actions">
              <Button variant="ghost" onClick={() => onOpenDefault(entry)}>
                Open in default app
              </Button>
              <Button variant="ghost" onClick={() => onDownload(entry)}>
                Download
              </Button>
            </div>
          </div>
        )}
      </div>

      {conflictText !== null && (
        <Dialog
          isOpen
          onClose={() => setConflictText(null)}
          title="File changed on disk"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConflictText(null)}>
                Cancel
              </Button>
              <Button
                className="btn-danger"
                onClick={() => {
                  setConflictText(null);
                  if (editorRef.current) void saveWith(editorRef.current, true);
                }}
              >
                Overwrite
              </Button>
            </>
          }
        >
          <p>
            {entry.name} was modified since you opened it — an agent may have written to it.
            Overwrite with your version?
          </p>
        </Dialog>
      )}
    </section>
  );
}
