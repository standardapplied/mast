import { describe, expect, mock, test } from "bun:test";
import { BridgeWatchdog, type Bridge } from "./watchdog";

class FakeSocket {
  closeListeners: Array<() => void> = [];
  closed = false;
  addEventListener(_type: "close", cb: () => void): void {
    this.closeListeners.push(cb);
  }
  close(): void {
    this.closed = true;
    for (const cb of [...this.closeListeners]) cb();
  }
}

class FakeBridge implements Bridge {
  bunSocket = new FakeSocket();
  initCalls = 0;
  initSocketToBun(): void {
    this.initCalls += 1;
    // Electrobun replaces the socket on re-init; mirror that so the watchdog
    // re-attaches its close listener to the fresh instance.
    this.bunSocket = new FakeSocket();
  }
}

function fakeTarget() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    listeners,
    addEventListener: (t: string, cb: () => void) => {
      (listeners[t] ??= []).push(cb);
    },
    removeEventListener: (t: string, cb: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((x) => x !== cb);
    },
  };
}

const noopTimers = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
  setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: () => {},
};

function makeWatchdog(over: {
  bridge: FakeBridge;
  ping: () => Promise<unknown>;
  reload?: () => void;
  reloadThreshold?: number;
  win?: ReturnType<typeof fakeTarget>;
  doc?: ReturnType<typeof fakeTarget>;
}) {
  return new BridgeWatchdog({
    bridge: over.bridge,
    ping: over.ping,
    reload: over.reload ?? (() => {}),
    reloadThreshold: over.reloadThreshold,
    timers: noopTimers,
    win: (over.win ?? fakeTarget()) as never,
    doc: (over.doc ?? fakeTarget()) as never,
  });
}

describe("BridgeWatchdog", () => {
  test("failed ping closes the socket and re-inits the bridge", async () => {
    const bridge = new FakeBridge();
    const reload = mock(() => {});
    const watchdog = makeWatchdog({ bridge, ping: () => Promise.reject(new Error("dead")), reload });

    watchdog.start();
    await watchdog.check();

    expect(bridge.initCalls).toBe(1);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a forced socket close (sleep) drives re-init via the close callback", () => {
    const bridge = new FakeBridge();
    const watchdog = makeWatchdog({ bridge, ping: () => Promise.resolve("pong") });

    watchdog.start();
    bridge.bunSocket.close();

    expect(bridge.initCalls).toBe(1);
  });

  test("reloads as a last resort after consecutive failed pings", async () => {
    const bridge = new FakeBridge();
    const reload = mock(() => {});
    const watchdog = makeWatchdog({
      bridge,
      ping: () => Promise.reject(new Error("dead")),
      reload,
      reloadThreshold: 3,
    });

    watchdog.start();
    await watchdog.check();
    await watchdog.check();
    await watchdog.check();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(bridge.initCalls).toBe(2);
  });

  test("a healthy ping resets the failure count", async () => {
    const bridge = new FakeBridge();
    const reload = mock(() => {});
    let alive = false;
    const watchdog = makeWatchdog({
      bridge,
      ping: () => (alive ? Promise.resolve("pong") : Promise.reject(new Error("dead"))),
      reload,
      reloadThreshold: 2,
    });

    watchdog.start();
    await watchdog.check(); // fail #1 → reconnect
    alive = true;
    await watchdog.check(); // recover, count resets
    alive = false;
    await watchdog.check(); // fail #1 again → reconnect, not reload

    expect(reload).not.toHaveBeenCalled();
  });

  test("registers focus and visibility health-check triggers", () => {
    const bridge = new FakeBridge();
    const win = fakeTarget();
    const doc = fakeTarget();
    const watchdog = makeWatchdog({ bridge, ping: () => Promise.resolve("pong"), win, doc });

    watchdog.start();

    expect(win.listeners.focus).toHaveLength(1);
    expect(doc.listeners.visibilitychange).toHaveLength(1);
  });
});
