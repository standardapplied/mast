import { describe, expect, test } from "bun:test";
import { FileTreeStore, type FileEntry, type FsApi } from "./fileTreeStore";

const dir = (name: string, base = "/root"): FileEntry => ({ name, path: `${base}/${name}`, isDir: true, size: 0 });
const file = (name: string, base = "/root"): FileEntry => ({ name, path: `${base}/${name}`, isDir: false, size: 1 });

type Pending = { path: string | null; done: boolean; resolve: (e: FileEntry[]) => void; reject: (e: unknown) => void };

function controllableFs() {
  const pending: Pending[] = [];
  const fs: FsApi = {
    list: (path) =>
      new Promise((res, rej) => {
        const p: Pending = {
          path,
          done: false,
          resolve: (entries) => {
            p.done = true;
            res({ path: path ?? "/root", entries });
          },
          reject: (e) => {
            p.done = true;
            rej(e);
          },
        };
        pending.push(p);
      }),
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const take = (path: string | null) => {
    const p = pending.find((x) => x.path === path && !x.done);
    if (!p) throw new Error(`no pending list for ${path}`);
    return p;
  };
  const countFor = (path: string | null) => pending.filter((x) => x.path === path).length;
  return { fs, settle, take, countFor };
}

describe("FileTreeStore", () => {
  test("loadRoot: loading → ready, and prefetches child dirs", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    expect(store.rootPath).toBeNull(); // list(null) still pending

    take(null).resolve([dir("sub"), file("a.txt")]);
    await settle();
    expect(store.rootPath).toBe("/root");
    expect(store.dir("/root")).toEqual({ status: "ready", entries: [dir("sub"), file("a.txt")], stale: false });
    // the one child dir was prefetched
    expect(countFor("/root/sub")).toBe(1);
  });

  test("dedupe: a prefetch in flight is not re-fetched when the user expands", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve([dir("sub")]); // prefetch fires for /root/sub
    await settle();
    expect(countFor("/root/sub")).toBe(1);

    store.toggle(dir("sub")); // expand while prefetch in flight
    await settle();
    expect(countFor("/root/sub")).toBe(1); // still one — deduped
  });

  test("stale-while-revalidate: re-expanding shows cache immediately, refreshes in background", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve([dir("sub")]);
    await settle();
    take("/root/sub").resolve([file("old.txt", "/root/sub")]); // prefetch resolves
    await settle();

    store.toggle(dir("sub"));
    await settle();
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready", stale: true }); // shown instantly, marked stale

    take("/root/sub").resolve([file("new.txt", "/root/sub")]); // background refresh
    await settle();
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready", stale: false });
    expect((store.dir("/root/sub") as { entries: FileEntry[] }).entries[0]!.name).toBe("new.txt");
  });

  test("a failed background refresh keeps the good cache", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve([dir("sub")]);
    await settle();
    take("/root/sub").resolve([file("keep.txt", "/root/sub")]);
    await settle();

    store.toggle(dir("sub"));
    await settle();
    take("/root/sub").reject(new Error("network blip"));
    await settle();
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready" }); // not error
    expect((store.dir("/root/sub") as { entries: FileEntry[] }).entries[0]!.name).toBe("keep.txt");
  });

  test("beginDelete locks a node (collapses it) until endDelete", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve([dir("sub")]);
    await settle();
    take("/root/sub").resolve([file("a.txt", "/root/sub")]); // prefetch
    await settle();

    store.toggle(dir("sub"));
    await settle();
    expect(store.isExpanded("/root/sub")).toBe(true);

    store.beginDelete("/root/sub");
    expect(store.isDeleting("/root/sub")).toBe(true);
    expect(store.isExpanded("/root/sub")).toBe(false); // collapsed so the subtree can't be acted on

    store.endDelete("/root/sub");
    expect(store.isDeleting("/root/sub")).toBe(false);
  });

  test("selection drives newFolderDir (folder → itself, file → parent, none → root)", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve([dir("sub"), file("a.txt")]);
    await settle();

    expect(store.newFolderDir()).toBe("/root");

    store.select(dir("sub"));
    expect(store.isSelected("/root/sub")).toBe(true);
    expect(store.newFolderDir()).toBe("/root/sub");

    store.select(file("a.txt"));
    expect(store.isSelected("/root/a.txt")).toBe(true);
    expect(store.newFolderDir()).toBe("/root");
  });

  test("prefetch is bounded to 10 child dirs", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    const many = Array.from({ length: 15 }, (_, i) => dir(`d${i}`));
    take(null).resolve(many);
    await settle();
    const prefetched = many.filter((d) => countFor(d.path) > 0).length;
    expect(prefetched).toBe(10);
  });

  test("root load error surfaces", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).reject(new Error("no route to host"));
    await settle();
    expect(store.rootError).toContain("no route to host");
  });

  test("responses after dispose() are dropped", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    store.dispose();
    take(null).resolve([dir("sub")]);
    await settle();
    expect(store.rootPath).toBeNull(); // ignored after dispose
  });
});
