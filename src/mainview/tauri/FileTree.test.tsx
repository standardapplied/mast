import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileTree, type FsApi, type FsListing } from "./FileTree";

let root: Root;
let container: HTMLElement;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

function fakeFs(): FsApi {
  const dirs: Record<string, FsListing> = {
    "/home/dev": {
      path: "/home/dev",
      entries: [
        { name: "workspace", path: "/home/dev/workspace", isDir: true, size: 0 },
        { name: "readme.md", path: "/home/dev/readme.md", isDir: false, size: 12 },
      ],
    },
    "/home/dev/workspace": {
      path: "/home/dev/workspace",
      entries: [{ name: "mast", path: "/home/dev/workspace/mast", isDir: true, size: 0 }],
    },
  };
  return {
    list: async (path) => dirs[path ?? "/home/dev"] ?? { path: path ?? "", entries: [] },
    upload: async () => [],
  };
}

async function render(fs: FsApi) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<FileTree target="mast" fs={fs} />));
  await flush();
}

const rows = () => [...container.querySelectorAll<HTMLElement>(".file-tree__row")];
const rowNamed = (name: string) => rows().find((r) => r.textContent?.trim() === name);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FileTree", () => {
  test("lists the login directory on mount, dirs and files", async () => {
    await render(fakeFs());
    expect(rows().map((r) => r.textContent?.trim())).toEqual(["workspace", "readme.md"]);
    expect(rowNamed("workspace")?.getAttribute("data-dir")).toBe("true");
    expect(rowNamed("readme.md")?.getAttribute("data-dir")).toBe("false");
  });

  test("expanding a directory loads its children; collapsing hides them", async () => {
    await render(fakeFs());
    await act(async () => rowNamed("workspace")!.click());
    await flush();
    expect(rowNamed("mast")).toBeDefined();

    await act(async () => rowNamed("workspace")!.click());
    await flush();
    expect(rowNamed("mast")).toBeUndefined();
  });

  test("clicking a file does not expand or crash", async () => {
    await render(fakeFs());
    await act(async () => rowNamed("readme.md")!.click());
    await flush();
    expect(rows().map((r) => r.textContent?.trim())).toEqual(["workspace", "readme.md"]);
  });

  test("surfaces a listing error", async () => {
    const fs: FsApi = { list: async () => Promise.reject(new Error("boom")), upload: async () => [] };
    await render(fs);
    expect(container.querySelector(".file-tree__note--error")?.textContent).toContain("boom");
  });
});
