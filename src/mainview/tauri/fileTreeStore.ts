export type FileEntry = { name: string; path: string; isDir: boolean; size: number };
export type FsListing = { path: string; entries: FileEntry[] };
/** Opaque continuation for a paged root listing: the backend's sort key of the
 *  last delivered entry, so a directory that changes between pages never
 *  skips undelivered entries (a numeric offset would). */
export type PageCursor = { isDir: boolean; name: string };
export type DeepListing = { listings: FsListing[]; truncated: boolean; nextCursor?: PageCursor | null };

export type FsApi = {
  /** Bounded subtree listing (`fs_list_deep`): the requested dir plus
   *  descendants down to the backend's depth/entry budget. `after` resumes a
   *  paged root listing where the previous response's `nextCursor` stopped. */
  listDeep: (path: string | null, after?: PageCursor) => Promise<DeepListing>;
};

export type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: FileEntry[]; stale: boolean; truncated?: boolean; nextCursor?: PageCursor }
  | { status: "error"; error: string };

/**
 * The file tree's data layer, deliberately framework-free so its concurrency
 * rules are unit-testable. Correctness first:
 *  - **dedupe:** one in-flight fetch per path, ever.
 *  - **stale-while-revalidate:** re-expanding a cached dir shows it instantly
 *    and refreshes in the background; a failed refresh keeps the good cache.
 *  - **deep seeding:** every fetch is a deep listing; all returned descendant
 *    directories are cached, so the next expansion renders with no fetch.
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
  private deleting = new Set<string>();
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
  isDeleting(path: string): boolean {
    return this.deleting.has(path);
  }

  /** Lock a node while it's being deleted: collapse it (so the vanishing subtree
   *  can't be acted on) and mark it so the row disables its own interactions. */
  beginDelete(path: string): void {
    this.deleting.add(path);
    this.expanded.delete(path);
    this.emit();
  }
  endDelete(path: string): void {
    if (this.deleting.delete(path)) this.emit();
  }
  get busy(): boolean {
    return this.inflight.size > 0;
  }

  private emit(): void {
    this.version++;
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  /** Cache every directory a deep listing returned. The requested dir carries
   *  the truncated flag (and, when its own listing was paged, the cursor to
   *  resume from); deeper seeds are plain fresh cache entries. */
  private seed(deep: DeepListing, requested: string): void {
    for (const listing of deep.listings) {
      const isRequested = listing.path === requested;
      this.nodes.set(listing.path, {
        status: "ready",
        entries: listing.entries,
        stale: false,
        ...(isRequested && deep.truncated && { truncated: true }),
        ...(isRequested && deep.nextCursor != null && { nextCursor: deep.nextCursor }),
      });
    }
  }

  /** Load the tree root — a specific directory, or the login dir when omitted. */
  async loadRoot(dir?: string | null): Promise<void> {
    this.rootPath = null;
    this.rootError = null;
    this.emit();
    try {
      const deep = await this.fs.listDeep(dir ?? null);
      if (this.disposed) return;
      const root = deep.listings[0];
      if (!root) throw new Error("empty deep listing");
      this.rootPath = root.path;
      this.seed(deep, root.path);
      this.emit();
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

  /** Re-root the tree at `dir` (right-click "Open as root"). */
  setRoot(dir: string): void {
    this.nodes.clear();
    this.expanded.clear();
    this.inflight.clear();
    void this.loadRoot(dir);
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

  /** Fetch the next page of a paged directory and append it — the way past a
   *  listing the backend capped. Deduped by path so a directory that changed
   *  between pages never shows an entry twice. */
  loadMore(path: string): void {
    const cached = this.nodes.get(path);
    if (cached?.status !== "ready" || cached.nextCursor === undefined) return;
    if (this.inflight.has(path)) return;
    void this.fetchMore(path, cached.nextCursor);
  }

  private async fetchMore(path: string, after: PageCursor): Promise<void> {
    this.inflight.add(path);
    this.emit();
    try {
      const deep = await this.fs.listDeep(path, after);
      if (this.disposed) return;
      const cached = this.nodes.get(path);
      const page = deep.listings.find((l) => l.path === path);
      if (cached?.status !== "ready" || !page) return;
      const seen = new Set(cached.entries.map((e) => e.path));
      this.nodes.set(path, {
        status: "ready",
        entries: [...cached.entries, ...page.entries.filter((e) => !seen.has(e.path))],
        stale: false,
        ...(deep.nextCursor != null && { truncated: true, nextCursor: deep.nextCursor }),
      });
      for (const listing of deep.listings) {
        if (listing.path === path) continue;
        this.nodes.set(listing.path, { status: "ready", entries: listing.entries, stale: false });
      }
    } catch {
      // A failed page load keeps the good partial cache; the more-row stays.
    } finally {
      this.inflight.delete(path);
      this.emit();
    }
  }

  private async fetch(path: string, background: boolean): Promise<void> {
    if (this.inflight.has(path)) return;
    this.inflight.add(path);
    this.emit();
    try {
      const deep = await this.fs.listDeep(path);
      if (this.disposed) return;
      if (deep.listings.length === 0) throw new Error("empty deep listing");
      this.seed(deep, path);
      this.emit();
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
}
