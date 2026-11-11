import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyReset, Markdown } from "./markdown";
import { highlight } from "./tauri/editorSeam";

const componentsCss = await Bun.file(new URL("./static/components.css", import.meta.url).pathname).text();

let root: Root;
let container: HTMLElement;

function render(source: string | ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(source);
}

function rerender(source: string | ReactNode) {
  act(() => root.render(typeof source === "string" ? <Markdown source={source} /> : source));
}

const copyButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("figure button")].find((button) =>
    /^Cop/.test(button.textContent ?? ""),
  )!;

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
    render(<Markdown source={"line one\nline two\n\n- item\n  goes on\n\n> said\n> twice"} message />);
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

    await act(async () => copyButton().click());
    expect(await navigator.clipboard.readText()).toBe(code);
    expect(copyButton().textContent).toBe("Copied");
  });

  test("a fence in a language the app does not load stays plain text, still with Copy", async () => {
    render("```cobol\nDISPLAY 'HI'.\n```");
    await act(async () => {
      await highlight("DISPLAY 'HI'.", "cobol");
    });
    expect(container.querySelector("pre code")?.innerHTML).toBe("DISPLAY 'HI'.");
    expect(copyButton()).toBeDefined();
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
    render(<Markdown source="@undefined @uday" message />);
    expect(container.querySelector(".mention-me")).toBeNull();
  });

  test("a mention of you is marked; another handle and an address are not", () => {
    render(<Markdown source="@uday look, @ravi too; mail uday@example.com" me="uday" message />);
    const marked = [...container.querySelectorAll(".mention-me")].map((node) => node.textContent);
    expect(marked).toEqual(["@uday"]);
    expect(container.textContent).toBe("@uday look, @ravi too; mail uday@example.com");
  });
});

describe("Markdown keeps what was typed", () => {
  test("a fence on one line is inline code, with nothing around it lost", () => {
    render(<Markdown source={"```const x = 1```"} message />);
    expect(container.querySelector("p code")?.textContent).toBe("const x = 1");
    expect(container.textContent).toBe("const x = 1");
  });

  test("what is typed after a closing fence's backticks is kept", () => {
    render(<Markdown source={"```\ncode\n``` and after"} message />);
    expect(container.querySelector("pre code")?.textContent).toBe("code\n``` and after");
  });

  test("a one-line fence after a line of text stays in that paragraph", () => {
    render(<Markdown source={"see\n```x = 1``` here"} message />);
    expect(container.querySelector(".markdown")?.innerHTML).toBe("<p>see<br><code>x = 1</code> here</p>");
  });

  test("blank lines before and after a message are not drawn", () => {
    render(<Markdown source={"\n\nhi\n\n\n"} message />);
    expect(container.querySelector(".markdown")?.innerHTML).toBe("<p>hi</p>");
  });

  test("a line of backticks that opens no fence is text", () => {
    render(<Markdown source={"```!! not a fence\nnext"} message />);
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("p")?.innerHTML).toBe("```!! not a fence<br>next");
  });

  test("a fence with an info string after its language is still that language", async () => {
    const code = "class A {}";
    render(`\`\`\`java title="A.java"\n${code}\n\`\`\``);
    await act(async () => {
      await highlight(code, "java");
    });
    expect(container.querySelector("pre code .tok-keyword")?.textContent).toBe("class");
  });

  test("an untagged fence names no language", () => {
    render("```\nplain\n```");
    expect(container.querySelector("figcaption .eyebrow")).toBeNull();
  });

  test("a list keeps the number it was typed with", () => {
    render("2. second point\n3. third");
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("2");
    rerender("2024. was a good year");
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("2024");
    expect(container.textContent).toBe("was a good year");
  });

  test("a code block re-rendered with other code shows that code, highlighted or not", async () => {
    render("```java\nclass A {}\n```");
    await act(async () => {
      await highlight("class A {}", "java");
    });
    rerender("```javax\nclass B {}\n```");
    expect(container.querySelector("pre code")?.textContent).toBe("class B {}");
    rerender("```java\nclass C {}\n```");
    expect(container.querySelector("pre code")?.textContent).toBe("class C {}");
  });

  test("a message keeps its tabs, runs of spaces, indentation and extra blank lines", () => {
    render(<Markdown source={"col1\tcol2\n    indented\n\n\n\nb"} message />);
    expect(container.querySelector(".markdown")?.innerHTML).toBe(
      "<p>col1\tcol2<br>    indented</p><br><br><p>b</p>",
    );
    const rule = componentsCss.match(/\.room-message-body \.markdown :is\(p, li, blockquote\) \{[^}]*\}/)?.[0];
    expect(rule).toContain("white-space: pre-wrap");
  });

  test("a lone asterisk between spaces is text", () => {
    render("2 * 3 * 4, and *this* is emphasis");
    expect(container.textContent).toBe("2 * 3 * 4, and this is emphasis");
    expect(container.querySelector("em")?.textContent).toBe("this");
  });

  test("a URL with balanced parentheses keeps them, bare or in a link", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    render(`see ${url}, or [Foo](${url}).`);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([url, url]);
  });

  test("a bare URL keeps parentheses in its middle", () => {
    render("see https://x.com/a_(b)_c now");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://x.com/a_(b)_c");
  });

  test("a bare URL's last character is not the sentence's punctuation", () => {
    render(<Markdown source={'go https://x.com! or "https://y.com";'} message />);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://x.com",
      "https://y.com",
    ]);
  });

  test("a document's relative and anchor links show their label, and mailto is a link", () => {
    render("[guide](./guide.md), [top](#top) and [mail](mailto:a@b.co)");
    expect(container.textContent).toBe("guide, top and mail");
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "mailto:a@b.co",
    ]);
  });

  test("a message shows a link it cannot open exactly as typed", () => {
    render(<Markdown source="[guide](./guide.md)" message />);
    expect(container.textContent).toBe("[guide](./guide.md)");
  });

  test("a mention inside a word is not marked", () => {
    render(<Markdown source="x@uday and @uday" me="uday" message />);
    expect(container.querySelectorAll(".mention-me").length).toBe(1);
  });

  test("a handle ending in an underscore is mentioned whole, and only it", () => {
    render(<Markdown source="@ada_ and @ada." me="ada_" message />);
    expect([...container.querySelectorAll(".mention-me")].map((mark) => mark.textContent)).toEqual([
      "@ada_",
    ]);
  });
});

describe("Markdown code block Copy", () => {
  function scheduled() {
    const pending: (() => void)[] = [];
    return {
      pending,
      schedule: (run: () => void) => {
        pending.push(run);
        return () => {};
      },
    };
  }

  test("Copy says Copied, announces it, and is Copy again after a moment", async () => {
    const timers = scheduled();
    render(
      <CopyReset.Provider value={timers.schedule}>
        <Markdown source={"```\nls -la\n```"} />
      </CopyReset.Provider>,
    );
    expect(copyButton().textContent).toBe("Copy");
    await act(async () => copyButton().click());

    expect(copyButton().textContent).toBe("Copied");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copied");
    act(() => timers.pending.forEach((run) => run()));
    expect(copyButton().textContent).toBe("Copy");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  test("a refused clipboard says Copy failed", async () => {
    const writeText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
    render("```\nls\n```");
    await act(async () => copyButton().click());
    navigator.clipboard.writeText = writeText;

    expect(copyButton().textContent).toBe("Copy failed");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copy failed");
  });
});
