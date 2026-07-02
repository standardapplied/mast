import { describe, expect, test } from "bun:test";
import type { EventStreamState, RecentEventsResponse, SailEvent } from "../../shared/sail-models";
import { EventStream, type StreamResponse } from "./sse";

/**
 * The stream, scheduler, and backfill source are all injected and driven
 * synchronously — no sleeps, no busy-polling.
 */

function pushable() {
  const queue: string[] = [];
  let resolveNext: ((r: IteratorResult<string>) => void) | null = null;
  let ended = false;
  return {
    push(chunk: string) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
    },
    end() {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (ended) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    } as AsyncIterable<string>,
  };
}

function fakeScheduler() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, ms, cancelled: false };
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

type Harness = ReturnType<typeof harness>;

function harness(recentEvents: SailEvent[] = []) {
  const scheduler = fakeScheduler();
  const streams: Array<ReturnType<typeof pushable> & { cancelled: boolean }> = [];
  const scripted: Array<{ status: number; retryAfter?: string }> = [];
  const connects: Array<Record<string, string>> = [];
  let recentCalls = 0;

  const stream = new EventStream(
    { server: "http://localhost:7070", token: "sess_t", project: "sail-mast" },
    {
      connect: async (_url, headers) => {
        connects.push(headers);
        const script = scripted.shift() ?? { status: 200 };
        const source = Object.assign(pushable(), { cancelled: false });
        streams.push(source);
        const response: StreamResponse = {
          status: script.status,
          header: (name) => (name === "Retry-After" ? (script.retryAfter ?? null) : null),
          chunks: source.iterable,
          cancel: () => {
            source.cancelled = true;
            source.end();
          },
        };
        return response;
      },
      recent: async (): Promise<RecentEventsResponse> => {
        recentCalls++;
        return { limit: 500, returned: recentEvents.length, events: recentEvents };
      },
      schedule: scheduler.schedule,
    },
  );

  const events: SailEvent[] = [];
  const states: EventStreamState[] = [];
  stream.onEvent((e) => events.push(e));
  stream.onState((s) => states.push(s));

  return {
    stream,
    scheduler,
    streams,
    scripted,
    connects,
    events,
    states,
    recentCalls: () => recentCalls,
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function frame(id: number, type: string): string {
  const event: SailEvent = {
    v: 1,
    id,
    ts: "2026-07-02T00:00:00Z",
    project: "sail-mast",
    type,
    agent: "claude-code",
    host: "devbox",
  };
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("EventStream", () => {
  test("delivers a spec_status_changed event to a subscriber", async () => {
    const h = harness();
    void h.stream.start();
    await flush();

    h.streams[0]!.push(": subscribed\n");
    h.streams[0]!.push(frame(1, "spec_status_changed"));
    await flush();

    expect(h.states).toEqual(["connecting", "connected"]);
    expect(h.events.map((e) => e.type)).toEqual(["spec_status_changed"]);
    h.stream.stop();
  });

  test("reconnects after a drop and backfills the gap without duplicates", async () => {
    const missed: SailEvent[] = [1, 2, 3].map((id) => ({
      v: 1,
      id,
      ts: "t",
      project: "sail-mast",
      type: `evt-${id}`,
      agent: "a",
      host: "h",
    }));
    const h = harness(missed);
    void h.stream.start();
    await flush();

    h.streams[0]!.push(frame(1, "evt-1"));
    await flush();
    h.streams[0]!.end();
    await flush();

    expect(h.stream.currentState).toBe("reconnecting");
    h.scheduler.firePending();
    await flush();

    expect(h.stream.currentState).toBe("connected");
    expect(h.recentCalls()).toBe(1);
    expect(h.events.map((e) => e.id)).toEqual([1, 2, 3]);

    h.streams[1]!.push(frame(4, "live"));
    await flush();
    expect(h.events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(h.connects[1]?.["Last-Event-ID"]).toBe("1");
    h.stream.stop();
  });

  test("no backfill on first connect; live duplicates are dropped", async () => {
    const h = harness();
    void h.stream.start();
    await flush();
    expect(h.recentCalls()).toBe(0);

    h.streams[0]!.push(frame(5, "a"));
    h.streams[0]!.push(frame(5, "a-again"));
    h.streams[0]!.push(frame(6, "b"));
    await flush();
    expect(h.events.map((e) => e.id)).toEqual([5, 6]);
    h.stream.stop();
  });

  test("honors Retry-After on a 503 connection cap", async () => {
    const h = harness();
    h.scripted.push({ status: 503, retryAfter: "1" }, { status: 200 });
    void h.stream.start();
    await flush();

    const retryTimer = h.scheduler.timers.find((t) => !t.cancelled);
    expect(retryTimer?.ms).toBe(1000);
    h.scheduler.firePending();
    await flush();

    expect(h.streams.length).toBe(2);
    h.streams[1]!.push(frame(1, "after-cap"));
    await flush();
    expect(h.events.length).toBe(1);
    h.stream.stop();
  });

  test("a silent stream trips the heartbeat watchdog and reconnects", async () => {
    const h = harness();
    void h.stream.start();
    await flush();

    h.streams[0]!.push(": subscribed\n");
    await flush();
    expect(h.stream.currentState).toBe("connected");

    h.scheduler.firePending();
    await flush();
    expect(h.streams[0]!.cancelled).toBe(true);

    h.scheduler.firePending();
    await flush();
    expect(h.streams.length).toBe(2);
    expect(h.stream.currentState).toBe("connected");
    h.stream.stop();
  });
});
