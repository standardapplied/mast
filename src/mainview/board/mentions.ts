/**
 * The `@handle` grammar of a room message, one for what notifies, what is drawn and what the
 * composer offers. A handle is sail's FDE handle, `[A-Za-z0-9][A-Za-z0-9._-]*`, so it may end in a
 * dot, a dash or an underscore; a mention of it is `@handle` followed by the end, a character no
 * handle has, or the dots that end a sentence. An `@` inside a word, as in an address, mentions no
 * one, and neither does a handle quoted as code.
 */

/** What a mention-mode room must be told to wake its agents: sail matches this literal only. */
export const AGENT_MENTION = "agent";

const HANDLE_CHARACTER = "[A-Za-z0-9._-]";

const CODE = /```[\s\S]*?(?:```|$)|`[^`]+`/g;

/** The pattern of a mention of `handle`, to find with {@link opensMention}. */
export function mentionPattern(handle: string): string {
  return `@${handle.replaceAll(".", "\\.")}(?=\\.*(?!${HANDLE_CHARACTER}))`;
}

export function opensMention(text: string, index: number): boolean {
  return index === 0 || !/[\w.@/-]/.test(text[index - 1]!);
}

export function mentions(text: string, handle: string): boolean {
  const prose = text.replace(CODE, (code) => " ".repeat(code.length));
  for (const match of prose.matchAll(new RegExp(mentionPattern(handle), "g"))) {
    if (opensMention(prose, match.index)) return true;
  }
  return false;
}

/** The `@query` the caret is in, or null: where it starts and what is typed after the `@`. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = new RegExp(`@(${HANDLE_CHARACTER}*)$`).exec(before);
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
  const rest = text.slice(caret).replace(new RegExp(`^${HANDLE_CHARACTER}*\\s?`), "");
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}
