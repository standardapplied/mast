import type { EventStreamState, RecentEventsResponse, SailEvent } from "../../shared/sail-models";
import { SSEParser } from "./sse-parser";

/**
 * Resilient consumer for GET /v1/events/stream. The server emits
 * `id: N\ndata: <json>\n\n` frames, a `: subscribed` comment on connect, and
 * `: keepalive` comments every 15s; over the 64-connection cap it answers 503
 * + Retry-After. The server does not read Last-Event-ID (we send it anyway),
 * so resume correctness comes from reconciling gaps via /v1/events/recent and
 * deduplicating on the monotonic event id. No polling: reconnects use
 * exponential backoff, and a stalled stream (no heartbeat for 45s) is torn
 * down and reconnected.
 */

export type StreamResponse = {
  status: number;
  header: (name: string) => string | null;
  chunks: AsyncIterable<string>;
  cancel: () => void;
};

export type EventStreamDeps = {
  connect: (url: string, headers: Record<string, string>) => Promise<StreamResponse>;
  recent: (limit: number) => Promise<RecentEventsResponse>;
  schedule: (fn: () => void, ms: number) => () => void;
};

export type EventStreamOptions = {
  server: string;
  token: string | null;
  project?: string;
  type?: string;
};

const HEARTBEAT_TIMEOUT_MS = 45_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BACKFILL_LIMIT = 500;

export function defaultEventStreamDeps(recent: EventStreamDeps["recent"]): EventStreamDeps {
  return {
    connect: async (url, headers) => {
      const controller = new AbortController();
      const response = await fetch(url, { headers, signal: controller.signal });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      return {
        status: response.status,
        header: (name) => response.headers.get(name),
        chunks: (async function* () {
          if (!reader) return;
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield decoder.decode(value, { stream: true });
          }
        })(),
        cancel: () => controller.abort(),
      };
    },
    recent,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
}

export class EventStream {
  private stopped = false;
  private state: EventStreamState = "disconnected";
  private lastSeenId: number | undefined;
  private everConnected = false;
  private failures = 0;
  private active: StreamResponse | null = null;
  private readonly eventListeners = new Set<(event: SailEvent) => void>();
  private readonly stateListeners = new Set<(state: EventStreamState) => void>();

  constructor(
    private readonly options: EventStreamOptions,
    private readonly deps: EventStreamDeps,
  ) {}

  onEvent(listener: (event: SailEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onState(listener: (state: EventStreamState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  get currentState(): EventStreamState {
    return this.state;
  }

  start(): Promise<void> {
    return this.run();
  }

  stop(): void {
    this.stopped = true;
    this.active?.cancel();
    this.setState("disconnected");
  }

  private setState(next: EventStreamState): void {
    if (this.state === next) return;
    this.state = next;
    this.stateListeners.forEach((l) => l(next));
  }

  private emit(event: SailEvent): void {
    if (event.id !== undefined) {
      if (this.lastSeenId !== undefined && event.id <= this.lastSeenId) return;
      this.lastSeenId = event.id;
    }
    this.eventListeners.forEach((l) => l(event));
  }

  private url(): string {
    const url = new URL(this.options.server + "/v1/events/stream");
    if (this.options.project) url.searchParams.set("project", this.options.project);
    if (this.options.type) url.searchParams.set("type", this.options.type);
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (this.lastSeenId !== undefined) headers["Last-Event-ID"] = String(this.lastSeenId);
    return headers;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.schedule(resolve, ms));
  }

  private backoffMs(): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures);
  }

  private async backfill(): Promise<void> {
    if (this.lastSeenId === undefined) return;
    try {
      const recent = await this.deps.recent(BACKFILL_LIMIT);
      const missed = recent.events
        .filter((e) => e.id !== undefined && e.id > (this.lastSeenId ?? 0))
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      missed.forEach((e) => this.emit(e));
    } catch {
      // backfill is best-effort; the live stream continues regardless
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.setState(this.everConnected ? "reconnecting" : "connecting");

      let response: StreamResponse;
      try {
        response = await this.deps.connect(this.url(), this.headers());
      } catch {
        this.failures++;
        await this.wait(this.backoffMs());
        continue;
      }

      if (response.status === 503) {
        const retryAfter = Number(response.header("Retry-After"));
        this.failures++;
        await this.wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs());
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
      await this.backfill();

      const parser = new SSEParser();
      let cancelWatchdog = this.deps.schedule(() => response.cancel(), HEARTBEAT_TIMEOUT_MS);

      try {
        for await (const chunk of response.chunks) {
          cancelWatchdog();
          cancelWatchdog = this.deps.schedule(() => response.cancel(), HEARTBEAT_TIMEOUT_MS);

          for (const frame of parser.feed(chunk).frames) {
            try {
              const parsed = JSON.parse(frame.data) as SailEvent;
              if (frame.id !== undefined && parsed.id === undefined) parsed.id = Number(frame.id);
              this.emit(parsed);
            } catch {
              // malformed frame — drop, mirroring the CLI consumer
            }
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
