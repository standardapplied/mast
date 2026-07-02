import type { ApiErrorBody } from "../../shared/sail-models";
import { diag } from "../diagnostics";
import type { SailConfig } from "./config";
import { RateLimiter } from "./rate-limiter";

let nanos: () => number;
try {
  nanos = () => Number(Bun.nanoseconds());
} catch {
  nanos = () => performance.now() * 1e6;
}

/** Typed failure carrying the server's error envelope. */
export class SailApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly action?: string,
  ) {
    super(message);
    this.name = "SailApiError";
  }
}

/** A 412 from a stale If-Match — reload, replay against the fresh ETag, retry. */
export class SailConflictError extends SailApiError {
  constructor(status: number, code: string, message: string, action?: string) {
    super(status, code, message, action);
    this.name = "SailConflictError";
  }
}

export type HttpDeps = {
  fetchFn: typeof fetch;
  limiter: RateLimiter;
  schedule: (fn: () => void, ms: number) => void;
};

export type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  ifMatch?: string;
};

export type ApiResult<T> = { data: T; etag?: string };

const RETRY_BASE_MS = 1000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

function defaultDeps(): HttpDeps {
  return {
    fetchFn: fetch,
    limiter: new RateLimiter(600, 60_000),
    schedule: (fn, ms) => void setTimeout(fn, ms),
  };
}

export class SailHttp {
  constructor(
    private readonly config: SailConfig,
    readonly deps: HttpDeps = defaultDeps(),
  ) {}

  get baseUrl(): string {
    return this.config.server;
  }

  get token(): string | null {
    return this.config.token;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const url = new URL(this.config.server + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 1; ; attempt++) {
      await this.deps.limiter.acquire();
      const started = nanos();
      let response: Response;
      try {
        response = await this.deps.fetchFn(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const ms = Math.round((nanos() - started) / 1e6);
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        if (timedOut) {
          diag.error("http", `${method} ${path} timed out`, { origin: url.origin, ms });
          throw new SailApiError(0, "timeout", `No response from ${url.origin} within 15s.`);
        }
        diag.error("http", `${method} ${path} network error`, {
          origin: url.origin,
          ms,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const ms = Math.round((nanos() - started) / 1e6);
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        diag.warn("http", `${method} ${path} rate-limited, retrying`, { attempt });
        await new Promise<void>((resolve) =>
          this.deps.schedule(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)),
        );
        continue;
      }

      if (!response.ok) {
        diag.warn("http", `${method} ${path} → ${response.status}`, { ms });
        throw await toApiError(response);
      }

      diag.info("http", `${method} ${path} → ${response.status}`, { ms });
      const etag = response.headers.get("ETag") ?? undefined;
      const data = (await response.json()) as T;
      return { data, etag };
    }
  }
}

async function toApiError(response: Response): Promise<SailApiError> {
  let code = "internal";
  let message = `HTTP ${response.status}`;
  let action: string | undefined;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error?.code) {
      code = body.error.code;
      message = body.error.message;
      action = body.error.action;
    }
  } catch {
    // non-JSON error body (e.g. SSE endpoint errors are text/plain)
  }
  if (response.status === 412) return new SailConflictError(412, code, message, action);
  return new SailApiError(response.status, code, message, action);
}
