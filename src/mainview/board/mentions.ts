/**
 * The `@handle` grammar of a room message, one for what notifies, what is drawn and what the
 * composer offers. A handle is an FDE handle (sail's `[A-Za-z0-9][A-Za-z0-9._-]*`) without the
 * punctuation of the sentence it ends, and an `@` inside a word, as in an address, mentions no one.
 */

export const MENTION = /@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

/** What a mention-mode room must be told to wake its agents: sail matches this literal only. */
export const AGENT_MENTION = "agent";

export function opensMention(text: string, index: number): boolean {
  return index === 0 || !/[\w.@/-]/.test(text[index - 1]!);
}

export function mentions(text: string, handle: string): boolean {
  for (const match of text.matchAll(MENTION)) {
    if (match[1] === handle && opensMention(text, match.index)) return true;
  }
  return false;
}

/** The `@query` the caret is in, or null: where it starts and what is typed after the `@`. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /@([A-Za-z0-9._-]*)$/.exec(before);
  if (!match || !opensMention(before, match.index)) return null;
  return { start: match.index, query: match[1]! };
}

/** `text` with the query at `start` replaced by `@handle` and a space, and where the caret goes. */
export function insertMention(
  text: string,
  caret: number,
  start: number,
  handle: string,
): { text: string; caret: number } {
  const inserted = `@${handle} `;
  const rest = text.slice(caret).replace(/^[A-Za-z0-9._-]*\s?/, "");
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}
