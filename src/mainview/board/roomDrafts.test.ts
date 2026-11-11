import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearErrors, recentErrors } from "../errorLog";
import { roomDrafts, STORAGE_KEY } from "./roomDrafts";

beforeEach(() => clearErrors());

afterEach(() => roomDrafts.reset());

const refusing = () => ({
  writes: 0,
  getItem: () => null,
  setItem(this: { writes: number }) {
    this.writes++;
    throw new DOMException("quota", "QuotaExceededError");
  },
});

test("a storage that refuses the write keeps what was typed, and says so once", () => {
  const storage = refusing();
  roomDrafts.connect(storage);
  let heard = 0;
  roomDrafts.subscribe(() => heard++);

  expect(() => roomDrafts.keep("design", "h")).not.toThrow();
  roomDrafts.keep("design", "he");

  expect(roomDrafts.draft("design")).toBe("he");
  expect(heard).toBe(2);
  expect(storage.writes).toBe(2);
  expect(recentErrors().map((error) => error.source)).toEqual(["room drafts"]);
});

test("a draft is written back to storage, and an empty one leaves it", () => {
  const stored = new Map<string, string>();
  roomDrafts.connect({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) });

  roomDrafts.keep("design", "half");
  expect(JSON.parse(stored.get(STORAGE_KEY)!)).toEqual({ design: "half" });
  roomDrafts.keep("design", "");
  expect(JSON.parse(stored.get(STORAGE_KEY)!)).toEqual({});
});
