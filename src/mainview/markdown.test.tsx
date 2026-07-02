import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./markdown";

let root: Root;
let container: HTMLElement;

function render(source: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Markdown source={source} />));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Markdown", () => {
  test("renders headings, paragraphs, lists, and fenced code", () => {
    render("# Title\n\nBody text.\n\n## Scope\n\n1. first\n2. second\n\n```bash\nsail sync\n```\n");
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("h2")?.textContent).toBe("Scope");
    expect(container.querySelectorAll("ol li").length).toBe(2);
    expect(container.querySelector("pre code")?.textContent).toBe("sail sync");
  });

  test("renders inline code, bold, and safe links only", () => {
    render("Use `bun test` and **never** sleep. [docs](https://bun.com) [evil](javascript:alert(1))");
    expect(container.querySelector("p code")?.textContent).toBe("bun test");
    expect(container.querySelector("strong")?.textContent).toBe("never");
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("https://bun.com");
    expect(container.textContent).toContain("evil");
  });

  test("never injects raw HTML", () => {
    render("<script>alert(1)</script> stays text");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  test("renders blockquotes and unordered lists", () => {
    render("> a quiet rule\n\n- one\n- two\n");
    expect(container.querySelector("blockquote")?.textContent).toBe("a quiet rule");
    expect(container.querySelectorAll("ul li").length).toBe(2);
  });
});
