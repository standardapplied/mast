import { describe, expect, test } from "bun:test";
import { urlRunAt } from "./links";
import type { Cell } from "./vtCore";

function row(text: string): Cell[] {
  const cells: Cell[] = [];
  for (const ch of text) {
    const wide = /\p{Script=Han}|\p{Emoji_Presentation}/u.test(ch);
    const cell = (t: string, width: number): Cell => ({
      text: t,
      fg: [0, 0, 0],
      bg: [0, 0, 0],
      bold: false,
      italic: false,
      underline: "none",
      underlineColor: null,
      strikethrough: false,
      overline: false,
      faint: false,
      invisible: false,
      selected: false,
      link: false,
      width,
    });
    cells.push(cell(ch, wide ? 2 : 1));
    if (wide) cells.push(cell("", 1));
  }
  return cells;
}

describe("urlRunAt", () => {
  test("finds the URL covering the column and reports its cell span", () => {
    const cells = row("see https://a.b/c now");
    expect(urlRunAt(cells, 4, 2)).toEqual({ uri: "https://a.b/c", y: 2, start: 4, end: 17 });
    expect(urlRunAt(cells, 16, 2)).toEqual({ uri: "https://a.b/c", y: 2, start: 4, end: 17 });
    expect(urlRunAt(cells, 17, 2)).toBeNull();
    expect(urlRunAt(cells, 0, 2)).toBeNull();
  });

  test("sentence punctuation and an unbalanced paren are not part of the link", () => {
    expect(urlRunAt(row("(https://x.y/z)."), 3, 0)?.uri).toBe("https://x.y/z");
    expect(urlRunAt(row("https://x.y/z),"), 3, 0)?.end).toBe(13);
    expect(urlRunAt(row("https://en.wikipedia.org/wiki/Foo_(bar)"), 3, 0)?.uri).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(urlRunAt(row("http://a.b/?q=1&r=2#f;"), 3, 0)?.uri).toBe("http://a.b/?q=1&r=2#f");
  });

  test("columns count wide glyphs twice, before and inside the link", () => {
    const cells = row("世界 https://a.b/世 x");
    const run = urlRunAt(cells, 6, 0);
    expect(run).toEqual({ uri: "https://a.b/世", y: 0, start: 5, end: 19 });
    expect(urlRunAt(cells, 18, 0)).toEqual(run);
    expect(urlRunAt(cells, 19, 0)).toBeNull();
  });

  test("only http and https count; ftp, file and bare hosts are text", () => {
    expect(urlRunAt(row("ftp://a.b file:///etc example.com"), 2, 0)).toBeNull();
    expect(urlRunAt(row("ftp://a.b file:///etc example.com"), 12, 0)).toBeNull();
    expect(urlRunAt(row("ftp://a.b file:///etc example.com"), 25, 0)).toBeNull();
  });

  test("the second URL on a row resolves independently of the first", () => {
    const cells = row("https://one.x https://two.y");
    expect(urlRunAt(cells, 20, 0)?.uri).toBe("https://two.y");
    expect(urlRunAt(cells, 13, 0)).toBeNull();
  });
});
