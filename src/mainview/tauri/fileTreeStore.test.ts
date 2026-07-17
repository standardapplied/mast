import { describe, expect, test } from "bun:test";
import { FileTreeStore, type DeepListing, type FileEntry, type FsApi } from "./fileTreeStore";

const dir = (name: string, base = "/root"): FileEntry => ({ name, path: `${base}/${name}`, isDir: true, size: 0 });
const file = (name: string, base = "/root"): FileEntry => ({ name, path: `${base}/${name}`, isDir: false, size: 1 });

type Pending = {
  path: string | null;
  done: boolean;
  resolve: (deep: DeepListing) => void;
  reject: (e: unknown) => void;
};

function controllableFs() {
  const pending: Pending[] = [];
  const fs: FsApi = {
    listDeep: (path) =>
      new Promise((res, rej) => {
        const p: Pending = {
          path,
          done: false,
          resolve: (deep) => {
            p.done = true;
            res(deep);
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
    if (!p) throw new Error(`no pending listDeep for ${path}`);
    return p;
  };
  const countFor = (path: string | null) => pending.filter((x) => x.path === path).length;
  return { fs, settle, take, countFor };
}

const deep = (listings: { path: string; entries: FileEntry[] }[], truncated = false): DeepListing => ({
  listings,
  truncated,
});

describe("FileTreeStore", () => {
  test("loadRoot: loading → ready, seeding every listed descendant", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    expect(store.rootPath).toBeNull(); // listDeep(null) still pending

    take(null).resolve(
      deep([
        { path: "/root", entries: [dir("sub"), file("a.txt")] },
        { path: "/root/sub", entries: [file("inner.txt", "/root/sub")] },
      ]),
    );
    await settle();
    expect(store.rootPath).toBe("/root");
    expect(store.dir("/root")).toEqual({ status: "ready", entries: [dir("sub"), file("a.txt")], stale: false });
    expect(store.dir("/root/sub")).toEqual({
      status: "ready",
      entries: [file("inner.txt", "/root/sub")],
      stale: false,
    });
    expect(countFor("/root/sub")).toBe(0); // seeded, not fetched
  });

  test("expanding a deep-seeded dir renders instantly (SWR refresh in background)", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(
      deep([
        { path: "/root", entries: [dir("sub")] },
        { path: "/root/sub", entries: [file("inner.txt", "/root/sub")] },
      ]),
    );
    await settle();

    store.toggle(dir("sub"));
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready", stale: true }); // instant, no spinner
    await settle();
    expect(countFor("/root/sub")).toBe(1); // one background refresh

    take("/root/sub").resolve(deep([{ path: "/root/sub", entries: [file("new.txt", "/root/sub")] }]));
    await settle();
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready", stale: false });
    expect((store.dir("/root/sub") as { entries: FileEntry[] }).entries[0]!.name).toBe("new.txt");
  });

  test("dedupe: one in-flight fetch per path, ever", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(deep([{ path: "/root", entries: [dir("sub")] }]));
    await settle();

    store.toggle(dir("sub")); // not cached → fetch
    store.revalidate("/root/sub"); // same path while in flight
    await settle();
    expect(countFor("/root/sub")).toBe(1);
  });

  test("a failed background refresh keeps the good cache", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(
      deep([
        { path: "/root", entries: [dir("sub")] },
        { path: "/root/sub", entries: [file("keep.txt", "/root/sub")] },
      ]),
    );
    await settle();

    store.toggle(dir("sub"));
    await settle();
    take("/root/sub").reject(new Error("network blip"));
    await settle();
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready" }); // not error
    expect((store.dir("/root/sub") as { entries: FileEntry[] }).entries[0]!.name).toBe("keep.txt");
  });

  test("a truncated walk marks the requested dir, not the seeded descendants", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(
      deep(
        [
          { path: "/root", entries: [dir("sub")] },
          { path: "/root/sub", entries: [file("inner.txt", "/root/sub")] },
        ],
        true,
      ),
    );
    await settle();
    expect(store.dir("/root")).toMatchObject({ truncated: true });
    expect(store.dir("/root/sub")).toEqual({
      status: "ready",
      entries: [file("inner.txt", "/root/sub")],
      stale: false,
    });
  });

  test("a fresh un-truncated fetch clears a previous truncated flag", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(deep([{ path: "/root", entries: [dir("sub")] }], true));
    await settle();
    expect(store.dir("/root")).toMatchObject({ truncated: true });

    store.revalidate("/root");
    await settle();
    take("/root").resolve(deep([{ path: "/root", entries: [dir("sub")] }]));
    await settle();
    expect(store.dir("/root")).toEqual({ status: "ready", entries: [dir("sub")], stale: false });
  });

  test("beginDelete locks a node (collapses it) until endDelete", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(
      deep([
        { path: "/root", entries: [dir("sub")] },
        { path: "/root/sub", entries: [file("a.txt", "/root/sub")] },
      ]),
    );
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

  test("root load error surfaces", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).reject(new Error("no route to host"));
    await settle();
    expect(store.rootError).toContain("no route to host");
  });

  test("an empty deep listing is an error, never a silently empty tree", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    take(null).resolve(deep([]));
    await settle();
    expect(store.rootError).toContain("empty deep listing");
  });

  test("responses after dispose() are dropped", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    store.dispose();
    take(null).resolve(deep([{ path: "/root", entries: [dir("sub")] }]));
    await settle();
    expect(store.rootPath).toBeNull(); // ignored after dispose
  });
});
