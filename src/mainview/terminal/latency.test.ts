import { afterEach, describe, expect, test } from "bun:test";
import { formatLatency, LATENCY_WINDOW, latencyChip, LatencyWindow, STORAGE_KEY } from "./latency";

describe("LatencyWindow", () => {
  test("empty until the first sample, then p50/p95 by nearest rank", () => {
    const w = new LatencyWindow();
    expect(w.stats()).toBeNull();
    expect(w.push(160)).toEqual({ p50: 160, p95: 160, count: 1 });
    for (const ms of [150, 170, 400, 165, 155, 160, 158, 162, 900]) w.push(ms);
    expect(w.stats()).toEqual({ p50: 160, p95: 900, count: 10 });
  });

  test("keeps only the last hundred keys", () => {
    const w = new LatencyWindow();
    for (let i = 0; i < LATENCY_WINDOW; i++) w.push(1000);
    for (let i = 0; i < LATENCY_WINDOW; i++) w.push(10);
    expect(w.stats()).toEqual({ p50: 10, p95: 10, count: LATENCY_WINDOW });
  });

  test("formats as the chip reads it, whole milliseconds", () => {
    expect(formatLatency({ p50: 162.4, p95: 239.6, count: 7 })).toBe("lat 162 / 240 ms");
  });
});

describe("latencyChip", () => {
  afterEach(() => latencyChip.reset());

  test("off by default; a stored 'on' seeds it; changes persist and notify", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    expect(latencyChip.shown()).toBe(false);
    let notified = 0;
    latencyChip.subscribe(() => notified++);
    latencyChip.set(true);
    expect(latencyChip.shown()).toBe(true);
    expect(notified).toBe(1);
    latencyChip.set(true);
    expect(notified).toBe(1);
    latencyChip.reset();
    store.set(STORAGE_KEY, "on");
    latencyChip.connect(storage);
    expect(latencyChip.shown()).toBe(true);
    latencyChip.set(false);
    expect(store.get(STORAGE_KEY)).toBe("off");
  });
});
