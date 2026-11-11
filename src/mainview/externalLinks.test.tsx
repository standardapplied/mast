import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { openLinksOutside } from "./externalLinks";
import { Markdown } from "./markdown";

let root: Root;
let container: HTMLElement;
let opened: string[];
let release: () => void;

beforeEach(() => {
  opened = [];
  release = openLinksOutside(document, async (url) => void opened.push(url));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(<Markdown source="Bare https://example.com/x and [a markdown link](https://bun.com)" breaks />),
  );
});

afterEach(() => {
  release();
  act(() => root.unmount());
  container.remove();
});

test("a click on a bare URL or a markdown link asks open_url, and the webview stays where it is", () => {
  const before = location.href;
  const clicks = [...container.querySelectorAll("a")].map((link) => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    return click.defaultPrevented;
  });

  expect(clicks).toEqual([true, true]);
  expect(opened).toEqual(["https://example.com/x", "https://bun.com"]);
  expect(location.href).toBe(before);
});

test("a click beside a link is the page's own", () => {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  container.querySelector("p")!.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(false);
  expect(opened).toEqual([]);
});
