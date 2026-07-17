import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import type { EditorConfig, EditorHandle } from "./editorSeam";

/**
 * The real editor behind the seam — the one lazily-imported CodeMirror chunk.
 * No colors here: `classHighlighter` emits stable `tok-*` classes and the base
 * UI is styled in components.css off tokens.css variables, so light/dark flip
 * live with the app, the same lockstep the terminal has.
 */

async function languageExtension(id: string | null): Promise<Extension> {
  switch (id) {
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    default:
      return [];
  }
}

export async function createCodeMirrorEditor(config: EditorConfig): Promise<EditorHandle> {
  const language = await languageExtension(config.language);

  let baseline = config.doc;
  let dirty = false;
  const trackDirty = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const next = update.state.doc.toString() !== baseline;
    if (next !== dirty) {
      dirty = next;
      config.onDirtyChange(dirty);
    }
  });

  const view = new EditorView({
    parent: config.parent,
    state: EditorState.create({
      doc: config.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        bracketMatching(),
        indentOnInput(),
        search({ top: true }),
        highlightSelectionMatches(),
        syntaxHighlighting(classHighlighter),
        language,
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              config.onSave();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.lineWrapping,
        trackDirty,
      ],
    }),
  });

  return {
    getText: () => view.state.doc.toString(),
    revealLine: (line) => {
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(clamped).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    },
    markSaved: () => {
      baseline = view.state.doc.toString();
      if (dirty) {
        dirty = false;
        config.onDirtyChange(false);
      }
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
