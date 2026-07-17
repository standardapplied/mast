import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorConfig, EditorFactory, EditorHandle } from "./editorSeam";
import type { FileEntry } from "./fileTreeStore";
import { ViewerPane } from "./ViewerPane";
import { ViewerStore, type ViewerFs } from "./viewerStore";

let root: Root;
let container: HTMLElement;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

const entry = (name: string, size = 10): FileEntry => ({ name, path: `/p/${name}`, isDir: false, size });

function fakeEditorFactory() {
  const instances: Array<{ config: EditorConfig; text: string; destroyed: boolean; revealed: number[] }> = [];
  const factory: EditorFactory = async (config) => {
    const inst = { config, text: config.doc, destroyed: false, revealed: [] as number[] };
    instances.push(inst);
    const handle: EditorHandle = {
      getText: () => inst.text,
      revealLine: (line) => void inst.revealed.push(line),
      markSaved: () => config.onDirtyChange(false),
      focus: () => {},
      destroy: () => {
        inst.destroyed = true;
      },
    };
    return handle;
  };
  return { factory, instances };
}

function makeFs(files: Record<string, { text?: string; bytes?: Uint8Array }>): ViewerFs {
  const bytes = (path: string) => files[path]!.bytes ?? new TextEncoder().encode(files[path]!.text ?? "");
  return {
    stat: async (path) => {
      if (!files[path]) throw new Error(`missing ${path}`);
      return { isDir: false, size: 5 };
    },
    read: async (path) => bytes(path),
    write: async (path, data) => {
      files[path]!.text = new TextDecoder().decode(data);
    },
    compareAndWrite: async (path, expected, data) => {
      const current = bytes(path);
      if (current.length !== expected.length || current.some((v, i) => v !== expected[i])) {
        return "conflict";
      }
      files[path]!.text = new TextDecoder().decode(data);
      return "saved";
    },
  };
}

const toasts: Array<{ message: string; ok: boolean }> = [];
const opened: FileEntry[] = [];
const downloaded: FileEntry[] = [];
let closed = 0;

function render(store: ViewerStore, factory: EditorFactory) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ViewerPane
        store={store}
        editorFactory={factory}
        onClose={() => closed++}
        onOpenDefault={(e) => opened.push(e)}
        onDownload={(e) => downloaded.push(e)}
        onToast={(message, ok) => toasts.push({ message, ok })}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  toasts.length = 0;
  opened.length = 0;
  downloaded.length = 0;
  closed = 0;
});

describe("ViewerPane", () => {
  test("renders nothing while closed", () => {
    const store = new ViewerStore(makeFs({}), () => {});
    const { factory } = fakeEditorFactory();
    render(store, factory);
    expect(container.querySelector('[data-testid="viewer"]')).toBeNull();
  });

  test("a text file mounts the editor seam with doc and language", async () => {
    const store = new ViewerStore(makeFs({ "/p/a.ts": { text: "const x = 1;" } }), () => {});
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.config.doc).toBe("const x = 1;");
    expect(instances[0]!.config.language).toBe("typescript");
    expect(container.querySelector(".viewer__name")?.textContent).toBe("a.ts");
  });

  test("dirty indicator follows the store; save clears it and toasts", async () => {
    const store = new ViewerStore(makeFs({ "/p/a.ts": { text: "old" } }), () => {});
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();

    act(() => instances[0]!.config.onDirtyChange(true));
    expect(container.querySelector('[data-testid="viewer-dirty"]')).not.toBeNull();

    instances[0]!.text = "new";
    await act(async () => {
      instances[0]!.config.onSave();
    });
    await flush();
    expect(toasts).toEqual([{ message: "Saved a.ts", ok: true }]);
    expect(container.querySelector('[data-testid="viewer-dirty"]')).toBeNull();
  });

  test("keystrokes during an in-flight save stay dirty", async () => {
    const files = { "/p/a.ts": { text: "old" } };
    const fs = makeFs(files);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => (releaseWrite = r));
    const write = fs.compareAndWrite;
    fs.compareAndWrite = async (path, expected, data) => {
      await gate;
      return write(path, expected, data);
    };
    const store = new ViewerStore(fs, () => {});
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();

    act(() => instances[0]!.config.onDirtyChange(true));
    instances[0]!.text = "captured";
    await act(async () => {
      instances[0]!.config.onSave();
    });
    instances[0]!.text = "captured plus later typing"; // arrives mid-write
    await act(async () => releaseWrite());
    await flush();

    expect(files["/p/a.ts"]!.text).toBe("captured");
    expect(toasts).toEqual([{ message: "Saved a.ts", ok: true }]);
    expect(container.querySelector('[data-testid="viewer-dirty"]')).not.toBeNull();
  });

  test("a conflicting save opens the overwrite dialog instead of writing", async () => {
    const files = { "/p/a.ts": { text: "old" } };
    const store = new ViewerStore(makeFs(files), () => {});
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();

    files["/p/a.ts"]!.text = "agent version"; // changed on disk since load
    instances[0]!.text = "mine";
    await act(async () => {
      instances[0]!.config.onSave();
    });
    await flush();
    expect(files["/p/a.ts"]!.text).toBe("agent version"); // not written
    expect(document.body.textContent).toContain("File changed on disk");

    const overwrite = [...document.querySelectorAll("button")].find((b) => b.textContent === "Overwrite")!;
    await act(async () => overwrite.click());
    await flush();
    expect(files["/p/a.ts"]!.text).toBe("mine");
  });

  test("markdown gets Write/Preview; preview renders through Markdown", async () => {
    const store = new ViewerStore(makeFs({ "/p/n.md": { text: "# Title" } }), () => {});
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("n.md")));
    await flush();

    instances[0]!.text = "# Fresh Title";
    const previewBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Preview")!;
    await act(async () => previewBtn.click());
    await flush();
    expect(container.querySelector('[data-testid="viewer-preview"] h1')?.textContent).toBe("Fresh Title");
  });

  test("non-markdown files get no Write/Preview toggle", async () => {
    const store = new ViewerStore(makeFs({ "/p/a.ts": { text: "x" } }), () => {});
    const { factory } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Preview")).toBe(false);
  });

  test("opens at a requested line", async () => {
    const store = new ViewerStore(makeFs({ "/p/a.ts": { text: "a\nb\nc" } }), () => {});
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts"), { line: 3 }));
    await flush();
    expect(instances[0]!.revealed).toEqual([3]);
  });

  test("an image renders an <img>; switching files destroys the old editor", async () => {
    const store = new ViewerStore(
      makeFs({ "/p/a.ts": { text: "x" }, "/p/shot.png": { bytes: new Uint8Array([1, 2]) } }),
      () => {},
    );
    const { factory, instances } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();
    await act(async () => store.open(entry("shot.png")));
    await flush();
    expect(instances[0]!.destroyed).toBe(true);
    expect(container.querySelector('[data-testid="viewer-image"]')).not.toBeNull();
  });

  test("the fallback card shows metadata and open/download escapes", async () => {
    const store = new ViewerStore(makeFs({ "/p/r.docx": { text: "zz" } }), () => {});
    const { factory } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("r.docx")));
    await flush();
    const card = container.querySelector('[data-testid="viewer-fallback"]')!;
    expect(card.textContent).toContain("r.docx");
    expect(card.textContent).toContain("Binary file");

    const buttons = [...card.querySelectorAll("button")];
    await act(async () => buttons.find((b) => b.textContent === "Open in default app")!.click());
    await act(async () => buttons.find((b) => b.textContent === "Download")!.click());
    expect(opened.map((e) => e.name)).toEqual(["r.docx"]);
    expect(downloaded.map((e) => e.name)).toEqual(["r.docx"]);
  });

  test("close button reports up", async () => {
    const store = new ViewerStore(makeFs({ "/p/a.ts": { text: "x" } }), () => {});
    const { factory } = fakeEditorFactory();
    render(store, factory);
    await act(async () => store.open(entry("a.ts")));
    await flush();
    await act(async () => container.querySelector<HTMLElement>(".viewer__close")!.click());
    expect(closed).toBe(1);
  });
});
