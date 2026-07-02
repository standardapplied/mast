import { describe, expect, test } from "bun:test";
import { TunnelManager, type TunnelChild, type TunnelState } from "./tunnel";

function fakeScheduler() {
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule(fn: () => void, _ms: number) {
      const entry = { fn, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    firePending() {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
  };
}

function fakeChild() {
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => (resolveExit = r));
  const child: TunnelChild & { killed: boolean; die: (code: number | null) => void } = {
    exited,
    killed: false,
    kill() {
      this.killed = true;
      resolveExit(null);
    },
    die(code) {
      resolveExit(code);
    },
  };
  return child;
}

function harness(opts: { healthyAfter?: number } = {}) {
  const scheduler = fakeScheduler();
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawns: string[][] = [];
  let healthCalls = 0;
  const healthyAfter = opts.healthyAfter ?? 0;
  let ports = 52700;

  const manager = new TunnelManager(
    { host: "devbox" },
    {
      spawn: (argv) => {
        spawns.push(argv);
        const child = fakeChild();
        children.push(child);
        return child;
      },
      pickPort: async () => ports++,
      healthCheck: async () => ++healthCalls > healthyAfter,
      schedule: scheduler.schedule,
    },
  );

  const states: TunnelState[] = [];
  manager.onState((s) => states.push(s));
  return { manager, scheduler, children, spawns, states, healthCalls: () => healthCalls };
}

const flush = async (times = 8) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

describe("TunnelManager", () => {
  test("spawns ssh, waits for health, reports up with the tunnel URL", async () => {
    const h = harness();
    void h.manager.start();
    await flush();

    expect(h.spawns[0]![0]).toBe("ssh");
    expect(h.states.map((s) => s.phase)).toEqual(["starting", "up"]);
    const up = h.states[1] as Extract<TunnelState, { phase: "up" }>;
    expect(up.server).toBe("http://127.0.0.1:52700");
    h.manager.stop();
    expect(h.children[0]!.killed).toBe(true);
  });

  test("health polls until the forward answers", async () => {
    const h = harness({ healthyAfter: 3 });
    void h.manager.start();
    await flush();
    expect(h.manager.currentState.phase).toBe("starting");

    for (let i = 0; i < 3; i++) {
      h.scheduler.firePending();
      await flush();
    }
    expect(h.manager.currentState.phase).toBe("up");
    h.manager.stop();
  });

  test("ssh dying flips to backoff and respawns on a fresh port", async () => {
    const h = harness();
    void h.manager.start();
    await flush();
    expect(h.manager.currentState.phase).toBe("up");

    h.children[0]!.die(255);
    await flush();
    expect(h.manager.currentState.phase).toBe("backoff");

    h.scheduler.firePending();
    await flush();
    expect(h.manager.currentState.phase).toBe("up");
    expect(h.spawns.length).toBe(2);
    expect((h.manager.currentState as Extract<TunnelState, { phase: "up" }>).port).toBe(52701);
    h.manager.stop();
  });

  test("gives up as failed after repeated consecutive failures", async () => {
    const h = harness({ healthyAfter: 10_000 });
    void h.manager.start();

    for (let round = 0; round < 200 && h.manager.currentState.phase !== "failed"; round++) {
      h.scheduler.firePending();
      await flush(4);
    }
    expect(h.manager.currentState.phase).toBe("failed");
  });

  test("stop kills the child and never respawns", async () => {
    const h = harness();
    void h.manager.start();
    await flush();
    h.manager.stop();
    await flush();
    h.scheduler.firePending();
    await flush();
    expect(h.spawns.length).toBe(1);
    expect(h.manager.currentState.phase).toBe("stopped");
  });
});
