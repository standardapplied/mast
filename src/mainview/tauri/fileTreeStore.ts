export type FileEntry = { name: string; path: string; isDir: boolean; size: number };
export type FsListing = { path: string; entries: FileEntry[] };

export type FsApi = {
  list: (path: string | null) => Promise<FsListing>;
};

export type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: FileEntry[]; stale: boolean }
  | { status: "error"; error: string };

/** How many child directories to prefetch per expansion (bounded, best-effort). */
const PREFETCH_LIMIT = 10;

/**
 * The file tree's data layer, deliberately framework-free so its concurrency
 * rules are unit-testable. Correctness first:
 *  - **dedupe:** one in-flight fetch per path, ever.
 *  - **stale-while-revalidate:** re-expanding a cached dir shows it instantly
 *    and refreshes in the background; a failed refresh keeps the good cache.
 *  - **prefetch:** expanding a dir prefetches its child dirs (capped) so the
 *    next expansion is instant.
 *  - **safe teardown:** responses arriving after `dispose()` are dropped, so a
 *    unmounted / retargeted tree never mutates.
 */
export class FileTreeStore {
  rootPath: string | null = null;
  rootError: string | null = null;
  /** Bumped on every state change so `useSyncExternalStore` can read it. */
  version = 0;

  private nodes = new Map<string, DirState>();
  private expanded = new Set<string>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly fs: FsApi) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  dir(path: string): DirState | undefined {
    return this.nodes.get(path);
  }
  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }
  get busy(): boolean {
    return this.inflight.size > 0;
  }

  private emit(): void {
    this.version++;
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  async loadRoot(): Promise<void> {
    this.rootPath = null;
    this.rootError = null;
    this.emit();
    try {
      const listing = await this.fs.list(null);
      if (this.disposed) return;
      this.rootPath = listing.path;
      this.nodes.set(listing.path, { status: "ready", entries: listing.entries, stale: false });
      this.emit();
      this.prefetchChildren(listing.entries);
    } catch (e) {
      if (this.disposed) return;
      this.rootError = String(e);
      this.emit();
    }
  }

  toggle(entry: FileEntry): void {
    if (!entry.isDir) return;
    if (this.expanded.has(entry.path)) {
      this.expanded.delete(entry.path);
      this.emit();
      return;
    }
    this.expanded.add(entry.path);
    const cached = this.nodes.get(entry.path);
    if (cached && cached.status === "ready") {
      // Show cached immediately, refresh in the background.
      this.nodes.set(entry.path, { ...cached, stale: true });
      this.emit();
      void this.fetch(entry.path, true);
    } else {
      this.nodes.set(entry.path, { status: "loading" });
      this.emit();
      void this.fetch(entry.path, false);
    }
  }

  /** Silent background refresh of a directory (after an upload, or manual). */
  revalidate(path: string): void {
    if (path === this.rootPath) {
      const cached = this.nodes.get(path);
      if (cached?.status === "ready") this.nodes.set(path, { ...cached, stale: true });
      this.emit();
    }
    void this.fetch(path, true);
  }

  refresh(): void {
    if (this.rootPath) this.revalidate(this.rootPath);
    else void this.loadRoot();
  }

  /** Expand a directory (loading it if needed) so a just-dropped file is seen.
   * The root is always visible, so revealing it is a no-op. */
  reveal(path: string): void {
    if (path === this.rootPath || this.expanded.has(path)) return;
    this.expanded.add(path);
    const cached = this.nodes.get(path);
    if (!cached || cached.status !== "ready") {
      this.nodes.set(path, { status: "loading" });
      void this.fetch(path, false);
    }
    this.emit();
  }

  private async fetch(path: string, background: boolean): Promise<void> {
    if (this.inflight.has(path)) return;
    this.inflight.add(path);
    this.emit();
    try {
      const listing = await this.fs.list(path);
      if (this.disposed) return;
      this.nodes.set(path, { status: "ready", entries: listing.entries, stale: false });
      this.emit();
      this.prefetchChildren(listing.entries);
    } catch (e) {
      if (this.disposed) return;
      // A failed background refresh keeps the (good) cached listing.
      if (!background) this.nodes.set(path, { status: "error", error: String(e) });
      this.emit();
    } finally {
      this.inflight.delete(path);
      this.emit();
    }
  }

  private prefetchChildren(entries: FileEntry[]): void {
    let budget = PREFETCH_LIMIT;
    for (const entry of entries) {
      if (budget <= 0) break;
      if (!entry.isDir || this.nodes.has(entry.path) || this.inflight.has(entry.path)) continue;
      budget -= 1;
      void this.prefetch(entry.path);
    }
  }

  private async prefetch(path: string): Promise<void> {
    if (this.inflight.has(path) || this.nodes.has(path)) return;
    this.inflight.add(path);
    this.emit();
    try {
      const listing = await this.fs.list(path);
      if (this.disposed) return;
      this.nodes.set(path, { status: "ready", entries: listing.entries, stale: false });
      this.emit();
    } catch {
      // best-effort; on-demand fetch will surface a real error if the user opens it
    } finally {
      this.inflight.delete(path);
      this.emit();
    }
  }
}
