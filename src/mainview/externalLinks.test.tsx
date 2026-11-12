import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { openLinksOutside } from "./externalLinks";
import { Markdown } from "./markdown";

let root: Root;
let container: HTMLElement;
let opened: string[] = [];

openLinksOutside(window, async (url) => void opened.push(url));

beforeEach(() => {
  opened = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <div onClick={(event) => event.stopPropagation()}>
        <Markdown source="Bare https://example.com/x and [a markdown link](https://bun.com)" message />
      </div>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const links = () => [...container.querySelectorAll("a")];

function follow(link: Element, type: "click" | "auxclick", button = 0): boolean {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  link.dispatchEvent(event);
  return event.defaultPrevented;
}

test("a click on a bare URL or a markdown link asks open_url, and the webview stays where it is", () => {
  const before = location.href;

  expect(links().map((link) => follow(link, "click"))).toEqual([true, true]);
  expect(opened).toEqual(["https://example.com/x", "https://bun.com"]);
  expect(location.href).toBe(before);
});

test("a link under an ancestor that stops the click still leaves through open_url", () => {
  expect(follow(links()[0]!, "click")).toBe(true);
  expect(opened).toEqual(["https://example.com/x"]);
});

test("a middle click opens the link outside too; a right click is the context menu's", () => {
  expect(follow(links()[1]!, "auxclick", 1)).toBe(true);
  expect(follow(links()[1]!, "auxclick", 2)).toBe(false);
  expect(opened).toEqual(["https://bun.com"]);
});

test("both entries route the page's links outside, before anything renders", async () => {
  for (const [entry, opener] of [
    ["index.tauri.tsx", "openLinksOutside(window, tauriTerminalServices.link.openUrl);"],
    ["index.demo.tsx", 'openLinksOutside(window, async (url) => void window.open(url, "_blank", "noopener"));'],
  ] as const) {
    const source = await Bun.file(new URL(`./${entry}`, import.meta.url).pathname).text();
    expect(source, entry).toContain(opener);
    expect(source.indexOf(opener), entry).toBeLessThan(source.indexOf("createRoot(container)"));
  }
});

test("a click beside a link is the page's own", () => {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  container.querySelector("p")!.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(false);
  expect(opened).toEqual([]);
});
