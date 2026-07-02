import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limiter";

function fakeClock() {
  let time = 0;
  const scheduled: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => time,
    schedule: (fn: () => void, ms: number) => {
      scheduled.push({ at: time + ms, fn });
    },
    advance(ms: number) {
      time += ms;
      const due = scheduled.filter((s) => s.at <= time);
      scheduled.length = 0;
      due.forEach((s) => s.fn());
    },
  };
}

describe("RateLimiter", () => {
  test("grants immediately under the limit", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, 60_000, clock);
    let granted = 0;
    for (let i = 0; i < 3; i++) await limiter.acquire().then(() => granted++);
    expect(granted).toBe(3);
  });

  test("queues past the limit and drains as the window slides", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, 60_000, clock);
    await limiter.acquire();
    clock.advance(10_000);
    await limiter.acquire();

    let third = false;
    const pending = limiter.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);

    clock.advance(50_000);
    await pending;
    expect(third).toBe(true);
  });
});
