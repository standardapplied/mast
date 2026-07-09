import { describe, expect, test } from "bun:test";
import type { AgentLogRole, RunView } from "../../shared/sail-models";
import type { StreamResponse } from "../../shared/sse";
import {
  AgentLogStream,
  latestRunId,
  type AgentLogLine,
  type AgentLogState,
} from "./agentLogStream";

/** Stream, scheduler, and connect are injected and driven synchronously. */
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

function harness(role: AgentLogRole = "build", initialSince = 0) {
  const scheduler = fakeScheduler();
  const streams: Array<ReturnType<typeof pushable> & { cancelled: boolean }> = [];
  const scripted: Array<{ status: number }> = [];
  const connects: Array<{ role: AgentLogRole; since: number }> = [];

  const stream = new AgentLogStream(
    role,
    {
      connect: async (r, since) => {
        connects.push({ role: r, since });
        const script = scripted.shift() ?? { status: 200 };
        const source = Object.assign(pushable(), { cancelled: false });
        streams.push(source);
        const response: StreamResponse = {
          status: script.status,
          header: () => null,
          chunks: source.iterable,
          cancel: () => {
            source.cancelled = true;
            source.end();
          },
        };
        return response;
      },
      schedule: scheduler.schedule,
    },
    initialSince,
  );

  const lines: AgentLogLine[] = [];
  const states: AgentLogState[] = [];
  stream.onLine((l) => lines.push(l));
  stream.onState((s) => states.push(s));

  return { stream, scheduler, streams, scripted, connects, lines, states };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function frame(id: number, text: string): string {
  return `id: ${id}\ndata: ${text}\n\n`;
}

describe("AgentLogStream", () => {
  test("delivers raw log lines with their ids", async () => {
    const h = harness();
    void h.stream.start();
    await flush();

    h.streams[0]!.push(": streaming sail-mast\n\n");
    h.streams[0]!.push(frame(1, `{"type":"assistant"}`));
    h.streams[0]!.push(frame(2, "plain codex line"));
    await flush();

    expect(h.states).toEqual(["connecting", "connected"]);
    expect(h.connects[0]).toEqual({ role: "build", since: 0 });
    expect(h.lines).toEqual([
      { id: 1, text: `{"type":"assistant"}` },
      { id: 2, text: "plain codex line" },
    ]);
    h.stream.stop();
  });

  test("resumes after a drop with since = lastId + 1, no gaps or dupes", async () => {
    const h = harness();
    void h.stream.start();
    await flush();

    h.streams[0]!.push(frame(7, "a"));
    h.streams[0]!.push(frame(8, "b"));
    await flush();
    h.streams[0]!.end();
    await flush();

    expect(h.stream.currentState).toBe("reconnecting");
    expect(h.stream.cursor).toBe(8);
    h.scheduler.firePending();
    await flush();

    expect(h.stream.currentState).toBe("connected");
    expect(h.connects[1]).toEqual({ role: "build", since: 9 });

    // The server, honoring since=9, resumes at line 9; a stray replay of 8 is dropped.
    h.streams[1]!.push(frame(8, "b-again"));
    h.streams[1]!.push(frame(9, "c"));
    await flush();
    expect(h.lines.map((l) => l.id)).toEqual([7, 8, 9]);
    expect(h.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
    h.stream.stop();
  });

  test("first connect honors the initial since cursor", async () => {
    const h = harness("review", 42);
    void h.stream.start();
    await flush();
    expect(h.connects[0]).toEqual({ role: "review", since: 42 });
    h.stream.stop();
  });

  test("a non-200 response backs off and retries", async () => {
    const h = harness();
    h.scripted.push({ status: 503 }, { status: 200 });
    void h.stream.start();
    await flush();

    const retry = h.scheduler.timers.find((t) => !t.cancelled);
    expect(retry?.ms).toBe(2000);
    h.scheduler.firePending();
    await flush();

    expect(h.streams.length).toBe(2);
    h.streams[1]!.push(frame(1, "after-retry"));
    await flush();
    expect(h.lines.map((l) => l.text)).toEqual(["after-retry"]);
    h.stream.stop();
  });

  test("a silent stream trips the heartbeat watchdog and reconnects", async () => {
    const h = harness();
    void h.stream.start();
    await flush();

    h.streams[0]!.push(frame(1, "x"));
    await flush();
    expect(h.stream.currentState).toBe("connected");

    h.scheduler.firePending();
    await flush();
    expect(h.streams[0]!.cancelled).toBe(true);

    h.scheduler.firePending();
    await flush();
    expect(h.streams.length).toBe(2);
    expect(h.connects[1]).toEqual({ role: "build", since: 2 });
    h.stream.stop();
  });
});

describe("latestRunId", () => {
  const run = (id: string, role: AgentLogRole, startedAt: string): RunView => ({
    id,
    project: "demo",
    node: "main",
    role,
    agent: "claude-code",
    status: "completed",
    started_at: startedAt,
  });

  test("picks the newest run of the requested role by started_at", () => {
    const runs = [
      run("older-build", "build", "2026-07-08T10:00:00Z"),
      run("newest-review", "review", "2026-07-09T12:00:00Z"),
      run("newest-build", "build", "2026-07-09T11:00:00Z"),
    ];
    expect(latestRunId(runs, "build")).toBe("newest-build");
    expect(latestRunId(runs, "review")).toBe("newest-review");
  });

  test("returns undefined when no run of the role exists", () => {
    expect(latestRunId([], "build")).toBeUndefined();
    expect(latestRunId([run("r", "review", "2026-07-09T11:00:00Z")], "build")).toBeUndefined();
  });
});
