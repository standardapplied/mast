import { routeFile, sniffBinary, type FallbackReason } from "./fileKind";
import type { FileEntry } from "./fileTreeStore";

/**
 * The viewer pane's data layer, framework-free like FileTreeStore: route a
 * file (extension + fs_stat size + NUL sniff), fetch its bytes lazily, and
 * guard saves against concurrent edits (agents write these files while you
 * look at them) — if the bytes on disk no longer match what was loaded, the
 * save reports a conflict instead of silently overwriting. Content is the
 * guard, not mtime: SFTP mtime is whole seconds, and agents easily rewrite a
 * file within the same second it was opened.
 */

export type ViewerFs = {
  stat: (path: string) => Promise<{ isDir: boolean; size: number }>;
  read: (path: string) => Promise<Uint8Array>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
};

const GOOGLE_POINTER_HOSTS = new Set(["docs.google.com", "drive.google.com"]);

/** A .gdoc/.gsheet/.gslides pointer comes from a remotely written file, so the
 *  URL it carries is untrusted input to the OS URL handler: only clean HTTPS
 *  Google URLs may leave the app. */
function googlePointerUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("no url in Google pointer file");
  const url = new URL(value);
  if (url.protocol !== "https:" || !GOOGLE_POINTER_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error("unsupported Google pointer URL");
  }
  return url.href;
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export type ViewerState =
  | { phase: "closed" }
  | { phase: "loading"; entry: FileEntry }
  | {
      phase: "text";
      entry: FileEntry;
      text: string;
      language: string | null;
      markdown: boolean;
      dirty: boolean;
      saving: boolean;
      loadedBytes: Uint8Array;
    }
  | { phase: "image"; entry: FileEntry; bytes: Uint8Array; mime: string }
  | { phase: "pdf"; entry: FileEntry; bytes: Uint8Array }
  | {
      phase: "fallback";
      entry: FileEntry;
      reason: FallbackReason | "error" | "gpointer";
      size: number;
      detail?: string;
    };

export type SaveResult = "saved" | "conflict" | "failed";

export class ViewerStore {
  state: ViewerState = { phase: "closed" };
  /** Bumped on every state change so `useSyncExternalStore` can read it. */
  version = 0;

  private revealLine: number | null = null;
  private seq = 0;
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly fs: ViewerFs,
    private readonly openUrl: (url: string) => void,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  get isOpen(): boolean {
    return this.state.phase !== "closed";
  }
  get isDirty(): boolean {
    return this.state.phase === "text" && this.state.dirty;
  }

  /** The line a caller asked to open at — read once by the editor mount. */
  takeRevealLine(): number | null {
    const line = this.revealLine;
    this.revealLine = null;
    return line;
  }

  private emit(): void {
    this.version++;
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private set(state: ViewerState): void {
    this.state = state;
    this.emit();
  }

  close(): void {
    this.seq++;
    this.set({ phase: "closed" });
  }

  setDirty(dirty: boolean): void {
    if (this.state.phase !== "text" || this.state.dirty === dirty) return;
    this.set({ ...this.state, dirty });
  }

  async open(entry: FileEntry, opts?: { line?: number }): Promise<void> {
    const ticket = ++this.seq;
    const fresh = () => !this.disposed && this.seq === ticket;
    this.revealLine = opts?.line ?? null;
    this.set({ phase: "loading", entry });
    try {
      const stat = await this.fs.stat(entry.path);
      if (!fresh()) return;
      const route = routeFile(entry.name, stat.size);
      switch (route.kind) {
        case "fallback":
          return this.set({ phase: "fallback", entry, reason: route.reason, size: stat.size });
        case "image": {
          const bytes = await this.fs.read(entry.path);
          if (!fresh()) return;
          return this.set({ phase: "image", entry, bytes, mime: route.mime });
        }
        case "pdf": {
          const bytes = await this.fs.read(entry.path);
          if (!fresh()) return;
          return this.set({ phase: "pdf", entry, bytes });
        }
        case "gpointer": {
          const bytes = await this.fs.read(entry.path);
          if (!fresh()) return;
          const url = googlePointerUrl((JSON.parse(new TextDecoder().decode(bytes)) as { url?: unknown }).url);
          this.openUrl(url);
          return this.set({
            phase: "fallback",
            entry,
            reason: "gpointer",
            size: stat.size,
            detail: "Opened in your browser",
          });
        }
        case "code":
        case "sniff": {
          const bytes = await this.fs.read(entry.path);
          if (!fresh()) return;
          if (sniffBinary(bytes)) {
            return this.set({ phase: "fallback", entry, reason: "binary", size: stat.size });
          }
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          const language = route.kind === "code" ? route.language : null;
          return this.set({
            phase: "text",
            entry,
            text,
            language,
            markdown: route.kind === "code" && route.markdown,
            dirty: false,
            saving: false,
            loadedBytes: bytes,
          });
        }
      }
    } catch (e) {
      if (!fresh()) return;
      this.set({ phase: "fallback", entry, reason: "error", size: entry.size, detail: String(e) });
    }
  }

  /** Write the editor's current text back. Refuses (as "conflict") when the
   *  bytes on disk no longer match what was loaded, unless forced. */
  async save(text: string, opts?: { force?: boolean }): Promise<SaveResult> {
    if (this.state.phase !== "text" || this.state.saving) return "failed";
    const ticket = this.seq;
    const fresh = () => !this.disposed && this.seq === ticket && this.state.phase === "text";
    const path = this.state.entry.path;
    const loadedBytes = this.state.loadedBytes;
    this.set({ ...this.state, saving: true });
    const done = (result: SaveResult, patch?: Partial<Extract<ViewerState, { phase: "text" }>>) => {
      if (fresh() && this.state.phase === "text") this.set({ ...this.state, saving: false, ...patch });
      return result;
    };
    try {
      if (!opts?.force) {
        const current = await this.fs.read(path);
        if (!fresh()) return "failed";
        if (!equalBytes(current, loadedBytes)) return done("conflict");
      }
      const encoded = new TextEncoder().encode(text);
      await this.fs.write(path, encoded);
      if (!fresh()) return "failed";
      return done("saved", {
        text,
        dirty: false,
        loadedBytes: encoded,
      });
    } catch {
      return done("failed");
    }
  }
}
