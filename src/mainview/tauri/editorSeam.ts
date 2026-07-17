/**
 * The thin seam in front of CodeMirror: the workbench renders/tests against
 * this interface, the real implementation (`codemirrorEditor.ts`) loads lazily
 * so app startup never pays for the editor chunk — and the dependency stays
 * swappable.
 */

export type EditorHandle = {
  getText(): string;
  /** Move the cursor to a 1-based line and scroll it into view. */
  revealLine(line: number): void;
  /** Reset the dirty baseline to the current doc (after a successful save). */
  markSaved(): void;
  focus(): void;
  destroy(): void;
};

export type EditorConfig = {
  parent: HTMLElement;
  doc: string;
  /** Language id from `fileKind.languageFor` — null renders plain text. */
  language: string | null;
  onDirtyChange: (dirty: boolean) => void;
  /** cmd+S inside the editor. */
  onSave: () => void;
};

export type EditorFactory = (config: EditorConfig) => Promise<EditorHandle>;

/** The production factory: pull in the CodeMirror chunk on first use. */
export const loadCodeMirrorEditor: EditorFactory = async (config) =>
  (await import("./codemirrorEditor")).createCodeMirrorEditor(config);
