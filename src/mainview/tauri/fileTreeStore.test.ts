import { describe, expect, test } from "bun:test";
import { FileTreeStore, type DeepListing, type FileEntry, type FsApi, type PageCursor } from "./fileTreeStore";

const dir = (name: string, base = "/root"): FileEntry => ({ name, path: `${base}/${name}`, isDir: true, size: 0 });
const file = (name: string, base = "/root"): FileEntry => ({ name, path: `${base}/${name}`, isDir: false, size: 1 });

type Pending = {
  path: string | null;
  after: PageCursor | undefined;
  depth: number | undefined;
  done: boolean;
  resolve: (deep: DeepListing) => void;
  reject: (e: unknown) => void;
};

function controllableFs() {
  const pending: Pending[] = [];
  const fs: FsApi = {
    listDeep: (path, after, depth) =>
      new Promise((res, rej) => {
        const p: Pending = {
          path,
          after,
          depth,
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

/** Drive loadRoot through both phases: the shallow paint gets the first
 *  listing alone, the deep background seed gets them all. */
async function seedRoot(
  store: FileTreeStore,
  h: { settle: () => Promise<void>; take: (path: string | null) => Pending },
  listings: { path: string; entries: FileEntry[] }[],
  truncated = false,
) {
  void store.loadRoot();
  await h.settle();
  h.take(null).resolve(deep([listings[0]!]));
  await h.settle();
  h.take(listings[0]!.path).resolve(deep(listings, truncated));
  await h.settle();
}

describe("FileTreeStore", () => {
  test("loadRoot: shallow first paint, then a deep background seed of descendants", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    expect(store.rootPath).toBeNull(); // listDeep(null) still pending

    const shallow = take(null);
    expect(shallow.depth).toBe(1); // first paint never waits on a subtree walk
    shallow.resolve(deep([{ path: "/root", entries: [dir("sub"), file("a.txt")] }]));
    await settle();
    expect(store.rootPath).toBe("/root"); // painted before the deep walk returns
    expect(store.dir("/root")).toEqual({ status: "ready", entries: [dir("sub"), file("a.txt")], stale: false });

    const seedFetch = take("/root");
    expect(seedFetch.depth).toBeUndefined(); // the background seed is the deep walk
    seedFetch.resolve(
      deep([
        { path: "/root", entries: [dir("sub"), file("a.txt")] },
        { path: "/root/sub", entries: [file("inner.txt", "/root/sub")] },
      ]),
    );
    await settle();
    expect(store.dir("/root/sub")).toEqual({
      status: "ready",
      entries: [file("inner.txt", "/root/sub")],
      stale: false,
    });
    expect(countFor("/root/sub")).toBe(0); // seeded, not fetched
  });

  test("expanding a deep-seeded dir renders instantly (shallow SWR refresh in background)", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [
      { path: "/root", entries: [dir("sub")] },
      { path: "/root/sub", entries: [file("inner.txt", "/root/sub")] },
    ]);

    store.toggle(dir("sub"));
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready", stale: true }); // instant, no spinner
    await settle();
    expect(countFor("/root/sub")).toBe(1); // one background refresh

    const refresh = take("/root/sub");
    expect(refresh.depth).toBe(1); // a refresh re-lists one dir, not a subtree
    refresh.resolve(deep([{ path: "/root/sub", entries: [file("new.txt", "/root/sub")] }]));
    await settle();
    expect(store.dir("/root/sub")).toMatchObject({ status: "ready", stale: false });
    expect((store.dir("/root/sub") as { entries: FileEntry[] }).entries[0]!.name).toBe("new.txt");
  });

  test("dedupe: one in-flight fetch per path, ever", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [{ path: "/root", entries: [dir("sub")] }]);

    store.toggle(dir("sub")); // not cached → fetch
    store.revalidate("/root/sub"); // same path while in flight
    await settle();
    expect(countFor("/root/sub")).toBe(1);
  });

  test("a cold expansion fetches deep so the next level renders instantly", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [{ path: "/root", entries: [dir("sub")] }]);

    store.toggle(dir("sub")); // never listed → the fetch seeds descendants too
    await settle();
    expect(take("/root/sub").depth).toBeUndefined();
  });

  test("a failed background refresh keeps the good cache", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [
      { path: "/root", entries: [dir("sub")] },
      { path: "/root/sub", entries: [file("keep.txt", "/root/sub")] },
    ]);

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
    await seedRoot(
      store,
      { settle, take },
      [
        { path: "/root", entries: [dir("sub")] },
        { path: "/root/sub", entries: [file("inner.txt", "/root/sub")] },
      ],
      true,
    );
    expect(store.dir("/root")).toMatchObject({ truncated: true });
    expect(store.dir("/root/sub")).toEqual({
      status: "ready",
      entries: [file("inner.txt", "/root/sub")],
      stale: false,
    });
  });

  test("a paged root records its continuation, and loadMore appends the next page deduped", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    const paged: DeepListing = {
      listings: [{ path: "/root", entries: [file("a.txt")] }],
      truncated: true,
      nextCursor: { isDir: false, name: "a.txt" },
    };
    void store.loadRoot();
    await settle();
    take(null).resolve(paged);
    await settle();
    expect(store.dir("/root")).toMatchObject({ truncated: true, nextCursor: { isDir: false, name: "a.txt" } });
    take("/root").resolve(paged); // the background deep seed settles first
    await settle();

    store.loadMore("/root");
    await settle();
    const page = take("/root");
    expect(page.after).toEqual({ isDir: false, name: "a.txt" }); // resumes where the backend stopped
    page.resolve({
      // A dir that shifted between pages can resend an entry — it must not double.
      listings: [{ path: "/root", entries: [file("a.txt"), file("b.txt")] }],
      truncated: false,
      nextCursor: null,
    });
    await settle();
    expect(store.dir("/root")).toEqual({
      status: "ready",
      entries: [file("a.txt"), file("b.txt")],
      stale: false,
    });
  });

  test("a middle page keeps the continuation; a failed page keeps the partial cache", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    const paged: DeepListing = {
      listings: [{ path: "/root", entries: [file("a.txt")] }],
      truncated: true,
      nextCursor: { isDir: false, name: "a.txt" },
    };
    void store.loadRoot();
    await settle();
    take(null).resolve(paged);
    await settle();
    take("/root").resolve(paged);
    await settle();

    store.loadMore("/root");
    await settle();
    take("/root").resolve({
      listings: [{ path: "/root", entries: [file("b.txt")] }],
      truncated: true,
      nextCursor: { isDir: false, name: "b.txt" },
    });
    await settle();
    expect(store.dir("/root")).toMatchObject({
      entries: [file("a.txt"), file("b.txt")],
      truncated: true,
      nextCursor: { isDir: false, name: "b.txt" },
    });

    store.loadMore("/root");
    await settle();
    take("/root").reject(new Error("network blip"));
    await settle();
    expect(store.dir("/root")).toMatchObject({
      entries: [file("a.txt"), file("b.txt")],
      nextCursor: { isDir: false, name: "b.txt" }, // still resumable
    });
  });

  test("a shallow revalidate shows a mutation immediately and clears a stale truncated flag", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [{ path: "/root", entries: [dir("sub")] }], true);
    expect(store.dir("/root")).toMatchObject({ truncated: true });

    store.revalidate("/root"); // what an upload triggers
    await settle();
    const refresh = take("/root");
    expect(refresh.depth).toBe(1); // one listing — the new file never waits on a subtree walk
    refresh.resolve(deep([{ path: "/root", entries: [dir("sub"), file("dropped.txt")] }]));
    await settle();
    expect(store.dir("/root")).toEqual({
      status: "ready",
      entries: [dir("sub"), file("dropped.txt")],
      stale: false,
    });
  });

  test("beginDelete locks a node (collapses it) until endDelete", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [
      { path: "/root", entries: [dir("sub")] },
      { path: "/root/sub", entries: [file("a.txt", "/root/sub")] },
    ]);

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

  test("responses after dispose() are dropped, and no background seed fires", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    void store.loadRoot();
    await settle();
    store.dispose();
    take(null).resolve(deep([{ path: "/root", entries: [dir("sub")] }]));
    await settle();
    expect(store.rootPath).toBeNull(); // ignored after dispose
    expect(countFor("/root")).toBe(0);
  });
});

describe("revalidate under load", () => {
  test("a revalidate during an inflight fetch is queued, never swallowed (upload-then-no-file bug)", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [{ path: "/root", entries: [file("a.txt")] }]);

    // A background refresh is inflight (slow link, deep walk still running)...
    store.revalidate("/root");
    await settle();
    const slow = take("/root");

    // ...when an upload lands and asks for a refresh. Pre-fix this was dropped on the floor.
    store.revalidate("/root");
    await settle();

    // The inflight fetch resolves with a listing that predates the upload.
    slow.resolve(deep([{ path: "/root", entries: [file("a.txt")] }]));
    await settle();

    // The queued revalidate must now run and land the post-upload truth.
    const queued = take("/root");
    queued.resolve(deep([{ path: "/root", entries: [file("a.txt"), file("dropped.png")] }]));
    await settle();
    const node = store.dir("/root");
    expect(node?.status).toBe("ready");
    expect(node?.status === "ready" && node.entries.map((e) => e.name)).toEqual([
      "a.txt",
      "dropped.png",
    ]);
  });
});

describe("refetch intent", () => {
  test("a queued foreground deep request replays with its own intent, not as a shallow background one", async () => {
    const { fs, settle, take } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [{ path: "/root", entries: [dir("sub")] }]);

    store.revalidate("/root/sub");
    await settle();
    const slow = take("/root/sub");
    expect(slow.depth).toBe(1);

    store.toggle(dir("sub"));
    await settle();

    slow.reject(new Error("gone mid-flight"));
    await settle();

    const replay = take("/root/sub");
    expect(replay.depth).toBeUndefined();
    replay.reject(new Error("really gone"));
    await settle();
    expect(store.dir("/root/sub")?.status).toBe("error");
  });

  test("setRoot clears queued refetches so an abandoned subtree never ghost-loads", async () => {
    const { fs, settle, take, countFor } = controllableFs();
    const store = new FileTreeStore(fs);
    await seedRoot(store, { settle, take }, [{ path: "/root", entries: [file("a.txt")] }]);

    store.revalidate("/root");
    await settle();
    const orphan = take("/root");
    store.revalidate("/root");
    await settle();

    store.setRoot("/other");
    await settle();
    const before = countFor("/root");
    orphan.resolve(deep([{ path: "/root", entries: [file("a.txt")] }]));
    await settle();
    expect(countFor("/root")).toBe(before);
  });
});
