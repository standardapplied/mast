import { describe, expect, test } from "bun:test";
import { classifyDrop, parentDir, shellQuote } from "./dropTarget";

function build(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

const TREE = `
  <div class="term-split">
    <div class="terminal-pane"><div class="terminal-pane__screen" id="term"></div></div>
    <div class="file-tree">
      <div class="file-tree__body" id="empty">
        <button data-path="/home/dev/workspace" data-dir="true" id="dir"><span id="dirname">workspace</span></button>
        <button data-path="/home/dev/readme.md" data-dir="false" id="file"><span id="filename">readme.md</span></button>
      </div>
    </div>
  </div>`;

describe("classifyDrop", () => {
  test("directory row → that directory", () => {
    const host = build(TREE);
    expect(classifyDrop(host.querySelector("#dirname"), "/home/dev")).toEqual({
      kind: "tree",
      dir: "/home/dev/workspace",
    });
    host.remove();
  });

  test("file row → its parent directory", () => {
    const host = build(TREE);
    expect(classifyDrop(host.querySelector("#filename"), "/home/dev")).toEqual({
      kind: "tree",
      dir: "/home/dev",
    });
    host.remove();
  });

  test("empty tree space → root directory", () => {
    const host = build(TREE);
    expect(classifyDrop(host.querySelector("#empty"), "/home/dev")).toEqual({
      kind: "tree",
      dir: "/home/dev",
    });
    host.remove();
  });

  test("terminal pane → terminal", () => {
    const host = build(TREE);
    expect(classifyDrop(host.querySelector("#term"), "/home/dev")).toEqual({ kind: "terminal" });
    host.remove();
  });

  test("outside tree and terminal → none; null → none", () => {
    const host = build(TREE);
    expect(classifyDrop(host, "/home/dev")).toEqual({ kind: "none" });
    expect(classifyDrop(null, "/home/dev")).toEqual({ kind: "none" });
    host.remove();
  });

  test("empty tree with no known root → none", () => {
    const host = build(TREE);
    expect(classifyDrop(host.querySelector("#empty"), null)).toEqual({ kind: "none" });
    host.remove();
  });
});

describe("parentDir", () => {
  test("nested and top-level", () => {
    expect(parentDir("/home/dev/workspace")).toBe("/home/dev");
    expect(parentDir("/home")).toBe("/");
    expect(parentDir("/a/b/c.txt")).toBe("/a/b");
  });
});

describe("shellQuote", () => {
  test("leaves safe paths, quotes spaces and specials", () => {
    expect(shellQuote("/home/dev/a.txt")).toBe("/home/dev/a.txt");
    expect(shellQuote("/home/dev/my file.txt")).toBe("'/home/dev/my file.txt'");
    expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
  });
});
