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
