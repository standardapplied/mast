import type { Cell, LinkRun } from "./vtCore";

/**
 * Plain-text URL detection on one row, the way Ghostty's `link-url` default reads it: an
 * `http(s)://` run up to whitespace, with the punctuation a sentence hangs on the end trimmed off.
 * A row is one cell per column — a wide glyph is followed by its own blank spacer cell — so the
 * column mapping is provable under `bun test`; the core calls it with the row it read.
 */

const URL = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?'"]+$/;

/** The URL whose text covers column {@code x} of {@code row}, or null. */
export function urlRunAt(row: readonly Cell[], x: number, y: number): LinkRun | null {
  let text = "";
  const columnOf: number[] = [];
  row.forEach((cell, column) => {
    for (let i = 0; i < cell.text.length; i++) columnOf.push(column);
    text += cell.text;
  });
  for (const match of text.matchAll(URL)) {
    const uri = trimUrl(match[0]);
    const start = columnOf[match.index]!;
    const last = columnOf[match.index + uri.length - 1]!;
    const end = last + (row[last]!.width === 2 ? 2 : 1);
    if (x >= start && x < end) {
      return { uri, y, start, end };
    }
  }
  return null;
}

/** Drops the sentence punctuation a URL is written into, and a `)` that closes nothing inside it. */
function trimUrl(raw: string): string {
  let uri = raw.replace(TRAILING, "");
  while (uri.endsWith(")") && count(uri, "(") < count(uri, ")")) {
    uri = uri.slice(0, -1).replace(TRAILING, "");
  }
  return uri;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}
