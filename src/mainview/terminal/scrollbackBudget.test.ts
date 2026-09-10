import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_SCROLLBACK_MIB, scrollbackBudget, STORAGE_KEY } from "./scrollbackBudget";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

afterEach(() => scrollbackBudget.reset());

describe("scrollbackBudget", () => {
  test("defaults to 20 MiB, in bytes for the core", () => {
    expect(scrollbackBudget.mib()).toBe(DEFAULT_SCROLLBACK_MIB);
    expect(scrollbackBudget.bytes()).toBe(20 * 1024 * 1024);
  });

  test("seeds from storage, ignoring a value that is not one of the choices", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "50");
    scrollbackBudget.connect(storage);
    expect(scrollbackBudget.mib()).toBe(50);
    storage.setItem(STORAGE_KEY, "7");
    scrollbackBudget.connect(storage);
    expect(scrollbackBudget.mib()).toBe(DEFAULT_SCROLLBACK_MIB);
  });

  test("a change notifies subscribers and lands in storage", () => {
    const storage = new MemoryStorage();
    scrollbackBudget.connect(storage);
    let notified = 0;
    scrollbackBudget.subscribe(() => notified++);
    scrollbackBudget.set(5);
    expect(notified).toBe(1);
    expect(storage.getItem(STORAGE_KEY)).toBe("5");
    expect(scrollbackBudget.bytes()).toBe(5 * 1024 * 1024);
    scrollbackBudget.set(5);
    expect(notified, "no change, no notice").toBe(1);
  });
});
