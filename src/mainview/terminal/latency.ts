/**
 * A number for every keystroke: how long a typed key takes to come back as pixels. The controller
 * measures each echoed key from keydown to the frame that painted its echo and feeds the samples
 * here; the pane shows a rolling p50/p95 on a chip when the user asked for it.
 *
 * The setting is app-wide and off by default. The one owner, in the presenceStore mold: a class
 * singleton read through `useSyncExternalStore`, persisted under {@link STORAGE_KEY} (a
 * preference, never existence).
 */

export const LATENCY_WINDOW = 100;
export const STORAGE_KEY = "mast.terminal.latency-chip";

export interface LatencyStats {
  readonly p50: number;
  readonly p95: number;
  readonly count: number;
}

/** The last {@link LATENCY_WINDOW} samples and their percentiles (nearest-rank). */
export class LatencyWindow {
  private readonly samples: number[] = [];

  push(ms: number): LatencyStats {
    this.samples.push(ms);
    if (this.samples.length > LATENCY_WINDOW) this.samples.shift();
    return this.stats()!;
  }

  stats(): LatencyStats | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
    return { p50: rank(0.5), p95: rank(0.95), count: sorted.length };
  }
}

/** The chip's text: "lat 162 / 240 ms". */
export function formatLatency(stats: LatencyStats): string {
  return `lat ${Math.round(stats.p50)} / ${Math.round(stats.p95)} ms`;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

class LatencyChipStore {
  private current = false;
  private storage: Storage | null = null;
  private readonly listeners = new Set<() => void>();

  /** Seeds the setting from persistent storage; every later change is written back there. */
  connect(storage: Storage): void {
    this.storage = storage;
    this.current = storage.getItem(STORAGE_KEY) === "on";
    this.emit();
  }

  readonly shown = (): boolean => this.current;

  set(shown: boolean): void {
    if (shown === this.current) return;
    this.current = shown;
    this.storage?.setItem(STORAGE_KEY, shown ? "on" : "off");
    this.emit();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Test seam: back to off with no storage attached. */
  reset(): void {
    this.storage = null;
    this.current = false;
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const latencyChip = new LatencyChipStore();
