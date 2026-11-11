import { describe, expect, test } from "bun:test";
import { insertMention, mentionQuery, mentions } from "./mentions";

describe("mentions", () => {
  test("a handle is mentioned by @handle, whole, wherever the sentence ends it", () => {
    expect(mentions("@uday look", "uday")).toBe(true);
    expect(mentions("thanks, @uday.", "uday")).toBe(true);
    expect(mentions("(@uday)", "uday")).toBe(true);
    expect(mentions("@udayk look", "uday")).toBe(false);
    expect(mentions("mail uday@example.com", "example.com")).toBe(false);
    expect(mentions("no one here", "uday")).toBe(false);
  });

  test("an @ after a slash, a dot or a dash is inside a word, and mentions no one", () => {
    for (const text of ["/@uday", ".@uday", "-@uday", "x@uday", "@@uday"]) {
      expect(mentions(text, "uday"), text).toBe(false);
    }
  });

  test("a handle is sail's: it may end in a dot, a dash or an underscore", () => {
    expect(mentions("@ada_ hi", "ada_")).toBe(true);
    expect(mentions("@ada_ hi", "ada")).toBe(false);
    expect(mentions("ask @a-b.", "a-b")).toBe(true);
    expect(mentions("ask @a-b.c", "a-b")).toBe(false);
    expect(mentions("thanks @uday...", "uday")).toBe(true);
  });

  test("a handle quoted as code mentions no one", () => {
    expect(mentions("run `notify @uday` now", "uday")).toBe(false);
    expect(mentions("```\n@uday\n```", "uday")).toBe(false);
    expect(mentions("``` @uday", "uday")).toBe(false);
    expect(mentions("`a` @uday `b`", "uday")).toBe(true);
  });

  test("the caret's query starts at an @ that opens a mention", () => {
    expect(mentionQuery("ping @bo", 8)).toEqual({ start: 5, query: "bo" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("ping @bo now", 12)).toBeNull();
    expect(mentionQuery("uday@ex", 7)).toBeNull();
  });

  test("an inserted mention replaces the whole word the caret is in and leaves one space", () => {
    expect(insertMention("ping @bo", 8, 5, "bob")).toEqual({ text: "ping @bob ", caret: 10 });
    expect(insertMention("ping @bo and", 7, 5, "bob")).toEqual({ text: "ping @bob and", caret: 10 });
  });
});
