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
