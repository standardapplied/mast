import { describe, expect, test } from "bun:test";
import { backoffDelay } from "./backoff";

describe("backoffDelay", () => {
  const opts = { baseMs: 1000, maxMs: 30_000 };

  test("first attempt returns base", () => {
    expect(backoffDelay(0, opts)).toBe(1000);
  });

  test("doubles each attempt", () => {
    expect(backoffDelay(1, opts)).toBe(2000);
    expect(backoffDelay(2, opts)).toBe(4000);
    expect(backoffDelay(3, opts)).toBe(8000);
  });

  test("caps at maxMs", () => {
    expect(backoffDelay(10, opts)).toBe(30_000);
  });
});
