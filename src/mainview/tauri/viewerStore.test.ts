import { describe, expect, test } from "bun:test";
import type { FileEntry } from "./fileTreeStore";
import { ViewerStore, type ViewerFs } from "./viewerStore";

const entry = (name: string, size = 10): FileEntry => ({ name, path: `/p/${name}`, isDir: false, size });

type Files = Record<string, { bytes?: Uint8Array; text?: string; size?: number }>;

function fakeFs(files: Files) {
  const calls = { read: [] as string[], write: [] as { path: string; text: string }[] };
  const get = (path: string) => {
    const f = files[path];
    if (!f) throw new Error(`missing ${path}`);
    return f;
  };
  const bytes = (path: string) => get(path).bytes ?? new TextEncoder().encode(get(path).text ?? "");
  const fs: ViewerFs = {
    stat: async (path) => {
      const f = get(path);
      return { isDir: false, size: f.size ?? bytes(path).length };
    },
    read: async (path) => {
      calls.read.push(path);
      return bytes(path);
    },
    write: async (path, data) => {
      const f = get(path);
      calls.write.push({ path, text: new TextDecoder().decode(data) });
      f.text = new TextDecoder().decode(data);
    },
    compareAndWrite: async (path, expected, data) => {
      const f = get(path);
      const current = bytes(path);
      if (current.length !== expected.length || current.some((v, i) => v !== expected[i])) {
        return "conflict";
      }
      calls.write.push({ path, text: new TextDecoder().decode(data) });
      f.text = new TextDecoder().decode(data);
      return "saved";
    },
  };
  return { fs, calls, files };
}

function makeStore(files: Files) {
  const { fs, calls } = fakeFs(files);
  const opened: string[] = [];
  const store = new ViewerStore(fs, (url) => opened.push(url));
  return { store, calls, opened };
}

describe("ViewerStore.open", () => {
  test("a .ts file loads as editable text with its language and byte baseline", async () => {
    const { store } = makeStore({ "/p/a.ts": { text: "const x = 1;" } });
    await store.open(entry("a.ts"));
    expect(store.state).toMatchObject({
      phase: "text",
      text: "const x = 1;",
      language: "typescript",
      markdown: false,
      dirty: false,
      loadedBytes: new TextEncoder().encode("const x = 1;"),
    });
  });

  test("markdown is flagged for the Write/Preview toggle", async () => {
    const { store } = makeStore({ "/p/n.md": { text: "# hi" } });
    await store.open(entry("n.md"));
    expect(store.state).toMatchObject({ phase: "text", markdown: true, language: "markdown" });
  });

  test("a NUL byte in a sniffed file falls back to the binary card", async () => {
    const { store } = makeStore({ "/p/mystery": { bytes: new Uint8Array([1, 0, 2]) } });
    await store.open(entry("mystery"));
    expect(store.state).toMatchObject({ phase: "fallback", reason: "binary" });
  });

  test("images load bytes and carry their mime", async () => {
    const { store } = makeStore({ "/p/shot.png": { bytes: new Uint8Array([137, 80]) } });
    await store.open(entry("shot.png"));
    expect(store.state).toMatchObject({ phase: "image", mime: "image/png" });
  });

  test("pdf loads bytes for the native embed", async () => {
    const { store } = makeStore({ "/p/doc.pdf": { bytes: new Uint8Array([37, 80]) } });
    await store.open(entry("doc.pdf"));
    expect(store.state).toMatchObject({ phase: "pdf" });
  });

  test("oversize text falls back without fetching bytes", async () => {
    const { store, calls } = makeStore({ "/p/big.ts": { text: "x", size: 3 * 1024 * 1024 } });
    await store.open(entry("big.ts"));
    expect(store.state).toMatchObject({ phase: "fallback", reason: "too-large", size: 3 * 1024 * 1024 });
    expect(calls.read).toEqual([]);
  });

  test("known binary extensions fall back without fetching bytes", async () => {
    const { store, calls } = makeStore({ "/p/r.docx": { text: "zzz" } });
    await store.open(entry("r.docx"));
    expect(store.state).toMatchObject({ phase: "fallback", reason: "binary" });
    expect(calls.read).toEqual([]);
  });

  test("a .gdoc pointer opens its url in the browser", async () => {
    const { store, opened } = makeStore({
      "/p/plan.gdoc": { text: JSON.stringify({ url: "https://docs.google.com/x" }) },
    });
    await store.open(entry("plan.gdoc"));
    expect(opened).toEqual(["https://docs.google.com/x"]);
    expect(store.state).toMatchObject({ phase: "fallback", reason: "gpointer" });
  });

  test("a pointer url off Google's https hosts never reaches the OS opener", async () => {
    const hostile = [
      "file:///etc/passwd",
      "smb://attacker/share",
      "http://docs.google.com/x",
      "https://evil.example.com/phish",
      "https://user:pass@docs.google.com/x",
      42,
    ];
    for (const url of hostile) {
      const { store, opened } = makeStore({ "/p/plan.gdoc": { text: JSON.stringify({ url }) } });
      await store.open(entry("plan.gdoc"));
      expect(opened).toEqual([]);
      expect(store.state).toMatchObject({ phase: "fallback", reason: "error" });
    }
  });

  test("a stat/read failure lands on the error card, never a broken render", async () => {
    const { store } = makeStore({});
    await store.open(entry("gone.ts"));
    expect(store.state).toMatchObject({ phase: "fallback", reason: "error" });
  });

  test("a second open supersedes a slow first one", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const slow: ViewerFs = {
      stat: async () => ({ isDir: false, size: 5 }),
      read: async (path) => {
        if (path === "/p/slow.ts") await gate;
        return new TextEncoder().encode(path);
      },
      write: async () => {},
      compareAndWrite: async () => "saved",
    };
    const store = new ViewerStore(slow, () => {});
    const first = store.open(entry("slow.ts"));
    await store.open(entry("fast.ts"));
    releaseFirst();
    await first;
    expect(store.state).toMatchObject({ phase: "text", text: "/p/fast.ts" });
  });

  test("takeRevealLine hands the requested line to exactly one reader", async () => {
    const { store } = makeStore({ "/p/a.ts": { text: "x" } });
    await store.open(entry("a.ts"), { line: 7 });
    expect(store.takeRevealLine()).toBe(7);
    expect(store.takeRevealLine()).toBeNull();
  });
});

describe("ViewerStore.save", () => {
  test("saves when the file is unchanged on disk and clears dirty", async () => {
    const { store, calls } = makeStore({ "/p/a.ts": { text: "old" } });
    await store.open(entry("a.ts"));
    store.setDirty(true);
    expect(store.isDirty).toBe(true);

    const result = await store.save("new text");
    expect(result).toBe("saved");
    expect(calls.write).toEqual([{ path: "/p/a.ts", text: "new text" }]);
    expect(calls.read).toEqual(["/p/a.ts"]); // the open only — no separate guard read before the write
    expect(store.state).toMatchObject({ phase: "text", dirty: false, saving: false });
  });

  test("reports a conflict (and does not write) when the content changed since load", async () => {
    // Content, not mtime, is the guard: an agent rewriting the file within the
    // same SFTP second must still be caught.
    const files: Files = { "/p/a.ts": { text: "old" } };
    const { fs, calls } = fakeFs(files);
    const store = new ViewerStore(fs, () => {});
    await store.open(entry("a.ts"));
    files["/p/a.ts"]!.text = "agent version"; // an agent wrote it while we looked

    const result = await store.save("mine");
    expect(result).toBe("conflict");
    expect(calls.write).toEqual([]);
    expect(store.state).toMatchObject({ phase: "text", saving: false });
  });

  test("force overwrites past a conflict", async () => {
    const files: Files = { "/p/a.ts": { text: "old" } };
    const { fs, calls } = fakeFs(files);
    const store = new ViewerStore(fs, () => {});
    await store.open(entry("a.ts"));
    files["/p/a.ts"]!.text = "agent version";

    expect(await store.save("mine", { force: true })).toBe("saved");
    expect(calls.write).toHaveLength(1);
  });

  test("a successful save becomes the next conflict baseline", async () => {
    const { store, calls } = makeStore({ "/p/a.ts": { text: "old" } });
    await store.open(entry("a.ts"));
    expect(await store.save("first")).toBe("saved");
    expect(await store.save("second")).toBe("saved");
    expect(calls.write.map((w) => w.text)).toEqual(["first", "second"]);
  });

  test("a failed write reports failed and keeps the pane editable", async () => {
    const files: Files = { "/p/a.ts": { text: "old" } };
    const { fs } = fakeFs(files);
    fs.compareAndWrite = async () => {
      throw new Error("sftp down");
    };
    const store = new ViewerStore(fs, () => {});
    await store.open(entry("a.ts"));
    store.setDirty(true);
    expect(await store.save("mine")).toBe("failed");
    expect(store.state).toMatchObject({ phase: "text", dirty: true, saving: false });
  });

  test("close empties the pane", async () => {
    const { store } = makeStore({ "/p/a.ts": { text: "x" } });
    await store.open(entry("a.ts"));
    store.close();
    expect(store.state).toEqual({ phase: "closed" });
    expect(store.isOpen).toBe(false);
  });
});
