import type { AgentLogRole, RunView } from "../../shared/sail-models";
import type { StreamResponse } from "../../shared/sse";
import { SSEParser } from "../../shared/sse-parser";

/**
 * Resilient consumer for one run's log via `GET /v1/runs/{id}/stream`. The
 * server emits `id: <line>\ndata: <raw log line>\n\n` frames, a `: streaming`
 * comment on connect, and `: heartbeat` comments every 15s. Each frame's `id`
 * is a monotonic line cursor: on any drop we reconnect with `since = lastId + 1`
 * so no line is lost or replayed, and we defensively drop any `id <= lastId`.
 *
 * The injected `connect` owns resolving the project+role to a concrete run id
 * (logs are run-addressed since sail's run aggregate landed), so this class
 * stays a pure cursor/reconnect machine.
 *
 * Deliberately transport-agnostic — `connect`/`schedule` are injected, so the
 * whole reconnect/cursor path is driven synchronously in tests without a shell,
 * a socket, or a sleep. The real deps back `connect` with the Rust stream pipe.
 */

/** The newest run for a role, trusting `started_at` over server order. */
export function latestRunId(runs: RunView[], role: AgentLogRole): string | undefined {
  return runs
    .filter((run) => run.role === role)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0]?.id;
}

export type AgentLogLine = { id: number; text: string };
export type AgentLogState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type AgentLogDeps = {
  connect: (role: AgentLogRole, since: number) => Promise<StreamResponse>;
  schedule: (fn: () => void, ms: number) => () => void;
};

const HEARTBEAT_TIMEOUT_MS = 45_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class AgentLogStream {
  private stopped = false;
  private state: AgentLogState = "disconnected";
  private lastId: number | undefined;
  private everConnected = false;
  private failures = 0;
  private active: StreamResponse | null = null;
  private readonly lineListeners = new Set<(line: AgentLogLine) => void>();
  private readonly stateListeners = new Set<(state: AgentLogState) => void>();

  constructor(
    private readonly role: AgentLogRole,
    private readonly deps: AgentLogDeps,
    private readonly initialSince = 0,
  ) {}

  onLine(listener: (line: AgentLogLine) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onState(listener: (state: AgentLogState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  get currentState(): AgentLogState {
    return this.state;
  }

  /** Highest line id delivered so far — the hook persists it per role. */
  get cursor(): number | undefined {
    return this.lastId;
  }

  start(): Promise<void> {
    return this.run();
  }

  stop(): void {
    this.stopped = true;
    this.active?.cancel();
    this.setState("disconnected");
  }

  private nextSince(): number {
    return this.lastId !== undefined ? this.lastId + 1 : this.initialSince;
  }

  private setState(next: AgentLogState): void {
    if (this.state === next) return;
    this.state = next;
    this.stateListeners.forEach((l) => l(next));
  }

  private emit(line: AgentLogLine): void {
    if (this.lastId !== undefined && line.id <= this.lastId) return;
    this.lastId = line.id;
    this.lineListeners.forEach((l) => l(line));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.schedule(resolve, ms));
  }

  private backoffMs(): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.setState(this.everConnected ? "reconnecting" : "connecting");

      let response: StreamResponse;
      try {
        response = await this.deps.connect(this.role, this.nextSince());
      } catch {
        this.failures++;
        await this.wait(this.backoffMs());
        continue;
      }

      if (response.status !== 200) {
        this.failures++;
        await this.wait(this.backoffMs());
        continue;
      }

      this.active = response;
      this.failures = 0;
      this.everConnected = true;
      this.setState("connected");

      const parser = new SSEParser();
      let cancelWatchdog = this.deps.schedule(() => response.cancel(), HEARTBEAT_TIMEOUT_MS);

      try {
        for await (const chunk of response.chunks) {
          cancelWatchdog();
          cancelWatchdog = this.deps.schedule(() => response.cancel(), HEARTBEAT_TIMEOUT_MS);

          for (const frame of parser.feed(chunk).frames) {
            if (frame.id === undefined) continue;
            const id = Number(frame.id);
            if (Number.isFinite(id)) this.emit({ id, text: frame.data });
          }
        }
      } catch {
        // stream error — fall through to reconnect
      } finally {
        cancelWatchdog();
        this.active = null;
      }

      if (!this.stopped) {
        this.setState("reconnecting");
        await this.wait(this.backoffMs());
      }
    }
    this.setState("disconnected");
  }
}
