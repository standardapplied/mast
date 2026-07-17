import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileTree, type FileActions } from "./FileTree";
import { FileTreeStore, type FileEntry, type FsApi, type FsListing } from "./fileTreeStore";

let root: Root;
let container: HTMLElement;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

function fakeFs(
  listings: Record<string, FsListing>,
  opts?: { truncated?: string[]; pageSize?: number },
): FsApi {
  return {
    listDeep: async (path, after) => {
      const key = path ?? "/home/dev";
      const listing = listings[key];
      if (!listing) return { listings: [{ path: key, entries: [] }], truncated: false };
      if (opts?.pageSize) {
        const start = after ? listing.entries.findIndex((e) => e.name === after.name) + 1 : 0;
        const page = listing.entries.slice(start, start + opts.pageSize);
        const more = start + page.length < listing.entries.length;
        const last = page[page.length - 1];
        return {
          listings: [{ path: listing.path, entries: page }],
          truncated: more,
          nextCursor: more && last ? { isDir: last.isDir, name: last.name } : null,
        };
      }
      return { listings: [listing], truncated: opts?.truncated?.includes(key) ?? false };
    },
  };
}

const defaultListings: Record<string, FsListing> = {
  "/home/dev": {
    path: "/home/dev",
    entries: [
      { name: "workspace", path: "/home/dev/workspace", isDir: true, size: 0 },
      { name: "readme.md", path: "/home/dev/readme.md", isDir: false, size: 12 },
      { name: "notes.txt", path: "/home/dev/notes.txt", isDir: false, size: 5 },
    ],
  },
  "/home/dev/workspace": {
    path: "/home/dev/workspace",
    entries: [{ name: "mast", path: "/home/dev/workspace/mast", isDir: true, size: 0 }],
  },
};

function spyActions() {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  const actions: FileActions = {
    open: record("open") as FileActions["open"],
    openDefault: record("openDefault") as FileActions["openDefault"],
    download: record("download") as FileActions["download"],
    remove: record("remove") as FileActions["remove"],
    rename: record("rename") as FileActions["rename"],
    newFolder: record("newFolder") as FileActions["newFolder"],
    newFile: record("newFile") as FileActions["newFile"],
    setRoot: record("setRoot") as FileActions["setRoot"],
    climbRoot: record("climbRoot") as FileActions["climbRoot"],
    copyPaths: record("copyPaths") as FileActions["copyPaths"],
  };
  return { actions, calls };
}

async function render(fs: FsApi, actions?: FileActions) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const store = new FileTreeStore(fs);
  void store.loadRoot();
  act(() => root.render(<FileTree store={store} actions={actions} />));
  await flush();
  return store;
}

const rows = () => [...container.querySelectorAll<HTMLElement>(".file-tree__row")];
const rowNamed = (name: string) =>
  rows().find((r) => r.querySelector(".file-tree__name")?.textContent === name);
const clickRow = async (name: string, init?: MouseEventInit) => {
  await act(async () =>
    rowNamed(name)!.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })),
  );
  await flush();
};
const selectedNames = () =>
  rows()
    .filter((r) => r.className.includes("--selected"))
    .map((r) => r.querySelector(".file-tree__name")?.textContent);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FileTree", () => {
  test("pins the root row first, then the listing", async () => {
    await render(fakeFs(defaultListings));
    const all = rows();
    expect(all[0]!.dataset.testid).toBe("root-row");
    expect(all[0]!.textContent).toContain("dev");
    expect(all[0]!.textContent).toContain("/home/dev");
    expect(all.slice(1).map((r) => r.querySelector(".file-tree__name")?.textContent)).toEqual([
      "workspace",
      "readme.md",
      "notes.txt",
    ]);
  });

  test("expanding a directory shows children; collapsing hides them", async () => {
    await render(fakeFs(defaultListings));
    await clickRow("workspace");
    expect(rowNamed("mast")).toBeDefined();
    await clickRow("workspace");
    expect(rowNamed("mast")).toBeUndefined();
  });

  test("clicking a file opens it in the viewer", async () => {
    const { actions, calls } = spyActions();
    await render(fakeFs(defaultListings), actions);
    await clickRow("readme.md");
    expect(calls.open).toHaveLength(1);
    expect((calls.open![0]![0] as FileEntry).path).toBe("/home/dev/readme.md");
  });

  test("surfaces a root listing error", async () => {
    const fs: FsApi = { listDeep: async () => Promise.reject(new Error("boom")) };
    await render(fs);
    expect(container.querySelector(".file-tree__note--error")?.textContent).toContain("boom");
  });

  test("cmd-click and shift-click build multi-selections of files and folders", async () => {
    await render(fakeFs(defaultListings));
    await clickRow("workspace");
    await clickRow("readme.md", { metaKey: true });
    expect(selectedNames().sort()).toEqual(["readme.md", "workspace"]);

    await clickRow("mast");
    await clickRow("notes.txt", { shiftKey: true });
    expect(selectedNames()).toEqual(["mast", "readme.md", "notes.txt"]);
  });

  test("Escape clears the selection", async () => {
    await render(fakeFs(defaultListings));
    await clickRow("notes.txt", { metaKey: true });
    expect(selectedNames()).toHaveLength(1);
    await act(async () =>
      container
        .querySelector(".file-tree__body")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(selectedNames()).toHaveLength(0);
  });

  test("the root row is selectable and deselectable", async () => {
    await render(fakeFs(defaultListings));
    const rootRow = () => container.querySelector<HTMLElement>('[data-testid="root-row"]')!;
    await act(async () => rootRow().click());
    expect(rootRow().className).toContain("--selected");
    await act(async () => rootRow().click());
    expect(rootRow().className).not.toContain("--selected");
  });

  test("keyboard: arrows move the focus selection, Enter opens", async () => {
    const { actions, calls } = spyActions();
    await render(fakeFs(defaultListings), actions);
    const body = container.querySelector(".file-tree__body")!;
    const key = async (k: string) =>
      act(async () => body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

    await clickRow("workspace"); // selects and expands
    await key("ArrowDown");
    expect(selectedNames()).toEqual(["mast"]); // into the expanded child
    await key("ArrowDown");
    expect(selectedNames()).toEqual(["readme.md"]);
    await key("Enter");
    expect((calls.open![0]![0] as FileEntry).path).toBe("/home/dev/readme.md");
    await key("ArrowUp");
    expect(selectedNames()).toEqual(["mast"]);
  });

  test("a context menu over a multi-selection acts on all of it", async () => {
    const { actions, calls } = spyActions();
    await render(fakeFs(defaultListings), actions);
    await clickRow("readme.md");
    await clickRow("notes.txt", { metaKey: true });
    await act(async () =>
      rowNamed("notes.txt")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
      ),
    );
    await flush();
    const del = [...document.querySelectorAll<HTMLElement>(".context-menu-item")].find((b) =>
      b.textContent?.includes("Delete 2 items"),
    )!;
    await act(async () => del.click());
    expect((calls.remove![0]![0] as FileEntry[]).map((e) => e.name).sort()).toEqual([
      "notes.txt",
      "readme.md",
    ]);
  });

  test("header New file targets the selected folder", async () => {
    const { actions, calls } = spyActions();
    await render(fakeFs(defaultListings), actions);
    await clickRow("workspace");
    await act(async () => container.querySelector<HTMLElement>('[aria-label="New file"]')!.click());
    expect(calls.newFile).toEqual([["/home/dev/workspace"]]);
  });

  test("a truncated listing surfaces the subtle more-row", async () => {
    await render(fakeFs(defaultListings, { truncated: ["/home/dev"] }));
    const more = container.querySelector('[data-testid="truncated-row"]');
    expect(more?.textContent).toContain("more — open to load");
  });

  test("a paged root's more-row is a button that loads the next page", async () => {
    await render(fakeFs(defaultListings, { pageSize: 2 }));
    expect(rows()).toHaveLength(3); // pinned root + the first page of two
    expect(rowNamed("notes.txt")).toBeUndefined();
    const more = container.querySelector<HTMLButtonElement>('button[data-testid="truncated-row"]')!;
    expect(more.textContent).toContain("show more");

    await act(async () => more.click());
    await flush();
    expect(rows()).toHaveLength(4); // notes.txt arrived
    expect(rowNamed("notes.txt")).toBeDefined();
    expect(container.querySelector('[data-testid="truncated-row"]')).toBeNull(); // fully listed
  });

  test("5,000 entries render a bounded DOM row count", async () => {
    const many: FsListing = {
      path: "/home/dev",
      entries: Array.from({ length: 5000 }, (_, i) => ({
        name: `f${i}.txt`,
        path: `/home/dev/f${i}.txt`,
        isDir: false,
        size: 1,
      })),
    };
    await render(fakeFs({ "/home/dev": many }));
    const count = rows().length;
    expect(count).toBeGreaterThan(10); // a real window rendered
    expect(count).toBeLessThan(100); // …but bounded by the viewport, not the listing
  });

  test("scrolling slides the window to deeper rows", async () => {
    const many: FsListing = {
      path: "/home/dev",
      entries: Array.from({ length: 5000 }, (_, i) => ({
        name: `f${i}.txt`,
        path: `/home/dev/f${i}.txt`,
        isDir: false,
        size: 1,
      })),
    };
    await render(fakeFs({ "/home/dev": many }));
    const body = container.querySelector<HTMLElement>(".file-tree__body")!;
    body.scrollTop = 24 * 2500;
    await act(async () => body.dispatchEvent(new Event("scroll", { bubbles: true })));
    await flush();
    expect(rowNamed("f2500.txt")).toBeDefined();
    expect(rowNamed("f0.txt")).toBeUndefined();
  });
});
