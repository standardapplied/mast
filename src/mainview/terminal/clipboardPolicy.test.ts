import { afterEach, describe, expect, test } from "bun:test";
import { clipboardPolicy, STORAGE_KEY } from "./clipboardPolicy";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

afterEach(() => clipboardPolicy.reset());

describe("clipboardPolicy", () => {
  test("allows by default, seeds from storage, and writes every change back", () => {
    expect(clipboardPolicy.mode()).toBe("allow");
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "deny");
    clipboardPolicy.connect(storage);
    expect(clipboardPolicy.mode()).toBe("deny");
    const seen: string[] = [];
    const unsubscribe = clipboardPolicy.subscribe(() => seen.push(clipboardPolicy.mode()));
    clipboardPolicy.set("allow");
    clipboardPolicy.set("allow");
    expect(seen, "a no-op set does not notify").toEqual(["allow"]);
    expect(storage.getItem(STORAGE_KEY)).toBe("allow");
    unsubscribe();
    clipboardPolicy.set("deny");
    expect(seen).toEqual(["allow"]);
  });

  test("a stored value that is not a mode falls back to allow", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "sometimes");
    clipboardPolicy.connect(storage);
    expect(clipboardPolicy.mode()).toBe("allow");
  });
});
