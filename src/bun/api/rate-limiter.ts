/**
 * Client-side sliding-window limiter honoring the control plane's 600 req/min
 * cap: acquire() resolves immediately while under the limit, otherwise queues
 * until the oldest timestamp ages out. Clock and timer are injectable so tests
 * drive time synchronously.
 */

export type RateLimiterDeps = {
  now: () => number;
  schedule: (fn: () => void, ms: number) => void;
};

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly waiters: Array<() => void> = [];
  private drainScheduled = false;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly deps: RateLimiterDeps = { now: Date.now, schedule: setTimeout },
  ) {}

  acquire(): Promise<void> {
    if (this.tryTake()) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.scheduleDrain();
    });
  }

  private tryTake(): boolean {
    const now = this.deps.now();
    while (this.timestamps.length > 0 && now - this.timestamps[0]! >= this.windowMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.timestamps.length === 0) return;
    this.drainScheduled = true;
    const wait = Math.max(1, this.windowMs - (this.deps.now() - this.timestamps[0]!));
    this.deps.schedule(() => {
      this.drainScheduled = false;
      while (this.waiters.length > 0 && this.tryTake()) {
        this.waiters.shift()!();
      }
      if (this.waiters.length > 0) this.scheduleDrain();
    }, wait);
  }
}
