import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./markdown";
import { highlight } from "./tauri/editorSeam";

let root: Root;
let container: HTMLElement;

function render(source: string | ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(typeof source === "string" ? <Markdown source={source} /> : source));
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
    expect(container.textContent).toContain("[evil](javascript:alert(1))");
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

  test("a document's wrapped lines flow into one paragraph", () => {
    render("one rule\nwrapped at the margin");
    expect(container.querySelector("p")?.innerHTML).toBe("one rule wrapped at the margin");
  });
});

describe("Markdown as a message", () => {
  test("a single line break is a line break, in a paragraph, a list item and a quote", () => {
    render(<Markdown source={"line one\nline two\n\n- item\n  goes on\n\n> said\n> twice"} breaks />);
    expect(container.querySelector("p")?.innerHTML).toBe("line one<br>line two");
    expect(container.querySelector("li")?.innerHTML).toBe("item<br>goes on");
    expect(container.querySelector("blockquote")?.innerHTML).toBe("said<br>twice");
  });

  test("a fence tagged java is highlighted, and Copy copies exactly what was typed", async () => {
    const code = 'class Room {\n  int seats = 2; // "two"\n}';
    render(`\`\`\`java\n${code}\n\`\`\``);
    await act(async () => {
      await highlight(code, "java");
    });
    const block = container.querySelector("pre code")!;
    expect(block.textContent).toBe(code);
    expect(block.querySelector(".tok-keyword")?.textContent).toBe("class");
    expect(block.querySelector(".tok-comment")?.textContent).toBe('// "two"');

    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;
    await act(async () => copy.click());
    expect(await navigator.clipboard.readText()).toBe(code);
    expect(copy.textContent).toBe("copied");
  });

  test("a fence in a language the app does not load stays plain text, still with Copy", async () => {
    render("```cobol\nDISPLAY 'HI'.\n```");
    await act(async () => {
      await highlight("DISPLAY 'HI'.", "cobol");
    });
    expect(container.querySelector("pre code")?.innerHTML).toBe("DISPLAY 'HI'.");
    expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
  });

  test("a bare http(s) URL is a link, its sentence's punctuation is not, and no link opens a window", () => {
    render("see https://example.com/x, or (https://example.com/y). Read [docs](https://bun.com).");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/x",
      "https://example.com/y",
      "https://bun.com",
    ]);
    expect(links.every((link) => !link.hasAttribute("target"))).toBe(true);
    expect(container.textContent).toBe(
      "see https://example.com/x, or (https://example.com/y). Read docs.",
    );
  });

  test("a URL inside bold is still a link", () => {
    render("**ship https://example.com/x**");
    expect(container.querySelector("strong a")?.getAttribute("href")).toBe("https://example.com/x");
  });

  test("with no reader known, no mention is marked", () => {
    render(<Markdown source="@undefined @uday" breaks />);
    expect(container.querySelector(".mention-me")).toBeNull();
  });

  test("a mention of you is marked; another handle and an address are not", () => {
    render(<Markdown source="@uday look, @ravi too; mail uday@example.com" me="uday" breaks />);
    const marked = [...container.querySelectorAll(".mention-me")].map((node) => node.textContent);
    expect(marked).toEqual(["@uday"]);
    expect(container.textContent).toBe("@uday look, @ravi too; mail uday@example.com");
  });
});
