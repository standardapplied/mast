import { BRIDGE_PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../shared/types";

/**
 * The Electrobun webview↔Bun bridge is a localhost WebSocket with NO
 * auto-reconnect: it silently dies after the laptop sleeps and the app wedges.
 * This watchdog is the required recovery mechanism.
 *
 * Strategy (per spec):
 *  - Ping every 30s and on window focus/visibility.
 *  - On a failed ping, close the socket; the socket's `close` event drives a
 *    single re-init path (`initSocketToBun`) — the same path used when the OS
 *    forcibly closes the socket on sleep.
 *  - After `reloadThreshold` consecutive failed pings, fall back to a full
 *    `location.reload()` (the Bun main stays alive, so this is cheap).
 *
 * Bun's socket is never shared across views (one per BrowserView); this watchdog
 * owns exactly one bridge instance.
 */

export interface BridgeSocket {
  addEventListener(type: "close", listener: () => void): void;
  close(): void;
}

export interface Bridge {
  bunSocket?: BridgeSocket;
  initSocketToBun(): void;
}

export type WatchdogOptions = {
  bridge: Bridge;
  /** Round-trips to the Bun main; rejects/hangs when the bridge is dead. */
  ping: () => Promise<unknown>;
  reload?: () => void;
  intervalMs?: number;
  pingTimeoutMs?: number;
  reloadThreshold?: number;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
  doc?: Pick<Document, "addEventListener" | "removeEventListener">;
  timers?: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (handle: ReturnType<typeof setInterval>) => void;
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
};

export class BridgeWatchdog {
  private readonly bridge: Bridge;
  private readonly ping: () => Promise<unknown>;
  private readonly reload: () => void;
  private readonly intervalMs: number;
  private readonly pingTimeoutMs: number;
  private readonly reloadThreshold: number;
  private readonly win: WatchdogOptions["win"];
  private readonly doc: WatchdogOptions["doc"];
  private readonly timers: NonNullable<WatchdogOptions["timers"]>;

  private failures = 0;
  private interval?: ReturnType<typeof setInterval>;
  private readonly onClose = () => this.reinit();
  private readonly onWake = () => {
    void this.check();
  };

  constructor(opts: WatchdogOptions) {
    this.bridge = opts.bridge;
    this.ping = opts.ping;
    this.reload = opts.reload ?? (() => location.reload());
    this.intervalMs = opts.intervalMs ?? BRIDGE_PING_INTERVAL_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
    this.reloadThreshold = opts.reloadThreshold ?? 3;
    this.win = opts.win ?? window;
    this.doc = opts.doc ?? document;
    this.timers = opts.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
    };
  }

  start(): void {
    this.attachCloseListener();
    this.interval = this.timers.setInterval(this.onWake, this.intervalMs);
    this.win?.addEventListener("focus", this.onWake);
    this.doc?.addEventListener("visibilitychange", this.onWake);
  }

  stop(): void {
    if (this.interval !== undefined) this.timers.clearInterval(this.interval);
    this.win?.removeEventListener("focus", this.onWake);
    this.doc?.removeEventListener("visibilitychange", this.onWake);
  }

  /** Health-check the bridge; recover on failure. Awaitable for tests. */
  async check(): Promise<void> {
    try {
      await this.withTimeout(this.ping());
      this.failures = 0;
    } catch {
      this.recover();
    }
  }

  private recover(): void {
    this.failures += 1;
    if (this.failures >= this.reloadThreshold) {
      this.failures = 0;
      this.reload();
      return;
    }
    // Closing drives the socket `close` event → reinit (single recovery path).
    this.bridge.bunSocket?.close();
  }

  private reinit(): void {
    this.bridge.initSocketToBun();
    this.attachCloseListener();
  }

  private attachCloseListener(): void {
    this.bridge.bunSocket?.addEventListener("close", this.onClose);
  }

  private withTimeout(promise: Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const handle = this.timers.setTimeout(
        () => reject(new Error("bridge ping timed out")),
        this.pingTimeoutMs,
      );
      promise.then(
        (value) => {
          this.timers.clearTimeout(handle);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(handle);
          reject(err);
        },
      );
    });
  }
}
