import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentLogResponse,
  AgentLogRole,
  AgentStatusResponse,
  ApiErrorBody,
  ConnectionStatus,
  EventStreamState,
  RecentEventsResponse,
  RunListResponse,
  SailEvent,
  SpecFilter,
} from "../../shared/sail-models";
import type { SailResult, SailWireError } from "../../shared/types";
import { EventStream, type StreamResponse } from "../../shared/sse";
import { formatRecentErrors, logError } from "../errorLog";
import type { AgentLogHandle, Gateway } from "../gateway";
import { AgentLogStream, latestRunId } from "./agentLogStream";

/**
 * The Tauri seam to the control plane. Every read/write is one `sail_request`
 * invoke — the Rust core owns the SSH session, injects the bearer token, and
 * proxies HTTP over a direct-tcpip forward to the devbox. The webview never
 * sees the token or the tunnel, exactly as the Electrobun Bun process hid them.
 *
 * This is the whole point of the pivot: the same React Gateway, now backed by
 * an in-process SSH stack that also runs on iOS/Android.
 */

type RustResponse = { status: number; etag: string | null; body: string };

type RawStatus = {
  phase: string;
  server: string;
  sshHost?: string;
  tokenPresent: boolean;
  tokenKind: "session" | "api" | "none";
  detail?: string;
};

async function sailRequest(
  method: string,
  path: string,
  opts: { body?: unknown; ifMatch?: string } = {},
): Promise<RustResponse> {
  return invoke<RustResponse>("sail_request", {
    method,
    path,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
    ifMatch: opts.ifMatch ?? null,
  });
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const q = search.toString();
  return q ? `?${q}` : "";
}

function parseError(status: number, body: string): SailWireError {
  try {
    const parsed = JSON.parse(body) as ApiErrorBody;
    if (parsed?.error?.code) {
      return {
        status,
        code: parsed.error.code,
        message: parsed.error.message,
        action: parsed.error.action,
      };
    }
  } catch {
    // non-JSON error body
  }
  return { status, code: "internal", message: `HTTP ${status}` };
}

// Set by createTauriGateway; invoked when a call reveals the session token is
// dead so the app can drop to the login screen instead of a dead retry loop.
let onAuthExpired: (() => void) | null = null;

async function read<T>(
  method: string,
  path: string,
  opts: { body?: unknown; ifMatch?: string } = {},
): Promise<SailResult<T>> {
  let response: RustResponse;
  try {
    response = await sailRequest(method, path, opts);
  } catch (error) {
    logError("api", `${method} ${path} → bridge: ${String(error)}`);
    return { ok: false, error: { status: 0, code: "bridge", message: String(error) } };
  }
  if (response.status < 200 || response.status >= 300) {
    const error = parseError(response.status, response.body);
    logError("api", `${method} ${path} → ${error.status} ${error.code}: ${error.message}`);
    // An expired/invalid *session* token means "you're logged out" — signal it so
    // the shell shows the login screen. Scoped to invalid_bearer_token only, so a
    // role 403 (e.g. non-admin dispatch) never logs anyone out.
    if (error.code === "invalid_bearer_token") onAuthExpired?.();
    return { ok: false, error };
  }
  const value = (response.body ? JSON.parse(response.body) : {}) as T;
  return { ok: true, value, etag: response.etag ?? undefined };
}

const EMPTY_CHUNKS: AsyncIterable<string> = {
  [Symbol.asyncIterator]() {
    return { next: () => Promise.resolve({ value: undefined as never, done: true }) };
  },
};

function timerSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/**
 * Adapts the Rust `stream_open`/`stream_close` pipe to the `StreamResponse`
 * shape the SSE consumers expect: one long-lived GET whose de-chunked body
 * arrives as `stream://data/{id}` text and terminates on `stream://end/{id}`.
 * The Rust core owns the token and the tunnel; the webview only ever sees text.
 */
async function tauriStreamConnect(path: string): Promise<StreamResponse> {
  const id = crypto.randomUUID();
  const queue: string[] = [];
  let resolveNext: ((r: IteratorResult<string>) => void) | null = null;
  let ended = false;
  let tornDown = false;
  let offOpen = () => {};
  let offData = () => {};
  let offEnd = () => {};

  let resolveStatus!: (status: number) => void;
  const statusReady = new Promise<number>((resolve) => {
    resolveStatus = resolve;
  });

  const push = (text: string) => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve({ value: text, done: false });
    } else {
      queue.push(text);
    }
  };
  // Tear down the listeners and stop the Rust pump. Runs on cancel (watchdog /
  // stop) AND on the stream ending naturally — the SSE consumers don't cancel a
  // stream that ends on its own, so without this each reconnect would leak.
  const closeStream = () => {
    if (tornDown) return;
    tornDown = true;
    offOpen();
    offData();
    offEnd();
    void invoke("stream_close", { id }).catch(() => {});
  };
  const finish = () => {
    if (!ended) {
      ended = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: undefined as never, done: true });
      }
    }
    closeStream();
  };

  offOpen = await listen<{ status: number }>(`stream://open/${id}`, (e) =>
    resolveStatus(e.payload.status),
  );
  offData = await listen<string>(`stream://data/${id}`, (e) => push(e.payload));
  offEnd = await listen(`stream://end/${id}`, () => finish());

  try {
    await invoke("stream_open", { id, path });
  } catch {
    closeStream();
    return { status: 0, header: () => null, chunks: EMPTY_CHUNKS, cancel: () => {} };
  }

  const status = await statusReady;
  const chunks: AsyncIterable<string> = {
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
  };

  return { status, header: () => null, chunks, cancel: finish };
}

async function latestRun(project: string, role: AgentLogRole): Promise<string | undefined> {
  const result = await read<RunListResponse>(
    "GET",
    `/v1/runs?project=${encodeURIComponent(project)}`,
  );
  return result.ok ? latestRunId(result.value.runs, role) : undefined;
}

function tauriAgentLog(project: string, role: AgentLogRole, since: number): AgentLogHandle {
  // Logs are run-addressed: resolve project+role to the newest run, re-resolving
  // on every reconnect until a line arrives (a dispatch may start the run after
  // the panel opens), then pin the run so the `since` cursor stays coherent.
  let runId: string | undefined;
  const stream: AgentLogStream = new AgentLogStream(
    role,
    {
      connect: async (r, s) => {
        if (!runId || stream.cursor === undefined) runId = await latestRun(project, r);
        if (!runId) throw new Error(`no ${r} run for '${project}' yet`);
        return tauriStreamConnect(`/v1/runs/${encodeURIComponent(runId)}/stream?since=${s}`);
      },
      schedule: timerSchedule,
    },
    since,
  );
  void stream.start();
  return {
    onLine: (listener) => stream.onLine(listener),
    onState: (listener) => stream.onState(listener),
    stop: () => stream.stop(),
  };
}

export function createTauriGateway(): Gateway {
  const recent = async (limit: number): Promise<RecentEventsResponse> => {
    const result = await read<RecentEventsResponse>("GET", `/v1/events/recent?limit=${limit}`);
    return result.ok ? result.value : { limit, returned: 0, events: [] };
  };

  // One resilient consumer for /v1/events/stream, backed by the Rust pipe: it is
  // what makes the board update live (spec_* / board_updated), and its state
  // drives the connection pill's stream health. The dummy origin only satisfies
  // EventStream.url()'s URL() parse — the Rust side owns routing and the token.
  const events = new EventStream(
    { server: "http://ipc.localhost", token: null },
    {
      connect: (url) => {
        const parsed = new URL(url);
        return tauriStreamConnect(parsed.pathname + parsed.search);
      },
      recent,
      schedule: timerSchedule,
    },
  );

  let streamState: EventStreamState = "disconnected";
  events.onState((state) => {
    streamState = state;
  });

  // The events stream is the app-wide live channel. Start it lazily on the first
  // subscriber (the board/detail mount once connected, so no pre-auth churn) and
  // then let it run for the gateway's lifetime — EventStream.stop() is terminal,
  // so a stop/restart across board↔detail navigation would leave a dead stream.
  let started = false;
  const ensureStarted = () => {
    if (!started) {
      started = true;
      void events.start();
    }
  };

  const baseConnection = async (): Promise<ConnectionStatus> => {
    try {
      const raw = await invoke<RawStatus>("connection_status");
      return {
        phase:
          raw.phase === "ready"
            ? "ready"
            : raw.phase === "unauthenticated"
              ? "unauthenticated"
              : raw.phase === "error"
                ? "failed"
                : "probing",
        server: raw.server,
        loginOrigin: raw.sshHost ? `ssh://${raw.sshHost}` : raw.server,
        tokenPresent: raw.tokenPresent,
        tokenKind: raw.tokenKind ?? (raw.tokenPresent ? "api" : "none"),
        stream: "disconnected",
        detail: raw.detail,
      };
    } catch (error) {
      return {
        phase: "failed",
        server: "",
        loginOrigin: "",
        tokenPresent: false,
        tokenKind: "none",
        stream: "disconnected",
        detail: String(error),
      };
    }
  };

  const connection = async (): Promise<ConnectionStatus> => {
    const base = await baseConnection();
    return { ...base, stream: base.phase === "ready" ? streamState : "disconnected" };
  };

  // On a dead session: clear the token and push an unauthenticated status to
  // every connection listener, so the shell shows the login screen. Guarded so a
  // burst of concurrent 401s collapses into a single logout.
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  let expiring = false;
  onAuthExpired = () => {
    if (expiring) return;
    expiring = true;
    void (async () => {
      await invoke("logout").catch(() => {});
      const status = await connection();
      statusListeners.forEach((listener) => listener(status));
      expiring = false;
    })();
  };

  return {
    listSpecs: (filter = {}) => read("GET", `/v1/specs${queryString(filter)}`),
    board: (project) => read("GET", `/v1/specs/board${queryString({ project })}`),
    getSpec: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}`),
    getSpecContent: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}/content`),
    putSpecContent: (id, content, ifMatch) =>
      read("PUT", `/v1/specs/${encodeURIComponent(id)}/content`, { body: content, ifMatch }),
    updateSpec: (id, request, ifMatch) =>
      read("PUT", `/v1/specs/${encodeURIComponent(id)}`, { body: request, ifMatch }),
    specHistory: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}/history`),
    restoreSpec: (id, rev) =>
      read("POST", `/v1/specs/${encodeURIComponent(id)}/restore`, { body: { rev } }),
    specReviews: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}/reviews`),
    dispatch: (project, request) =>
      read("POST", `/v1/projects/${encodeURIComponent(project)}/dispatch`, { body: request }),
    whoami: () => read("GET", "/v1/whoami"),
    listProjects: () => read("GET", "/v1/projects"),

    agentStatus: (project) =>
      read<AgentStatusResponse>("GET", `/v1/projects/${encodeURIComponent(project)}/agent`),
    agentLogSnapshot: async (project, role, tail) => {
      const runId = await latestRun(project, role);
      if (!runId) {
        return {
          ok: false,
          error: {
            status: 404,
            code: "run_not_found",
            message: `No ${role} run for '${project}' yet.`,
          },
        };
      }
      return read<AgentLogResponse>(
        "GET",
        `/v1/runs/${encodeURIComponent(runId)}/log?tail=${tail}`,
      );
    },
    followAgentLog: (project, role, since) => tauriAgentLog(project, role, since),

    connection,

    async login() {
      try {
        await invoke("login");
        const status = await connection();
        return { ok: status.phase === "ready" };
      } catch (error) {
        return { ok: false, detail: String(error) };
      }
    },

    async logout() {
      await invoke("logout");
    },

    async diagnostics() {
      const status = await connection();
      const report = [
        "=== Mast diagnostics (Tauri) ===",
        JSON.stringify(status, null, 2),
        "",
        "=== Recent errors ===",
        formatRecentErrors(),
      ].join("\n");
      return { report, logPath: "(Tauri backend)" };
    },

    onEvent(listener: (event: SailEvent) => void) {
      const off = events.onEvent(listener);
      ensureStarted();
      return off;
    },

    onConnectionStatus(listener: (status: ConnectionStatus) => void) {
      statusListeners.add(listener);
      void connection().then(listener);
      const offState = events.onState(() => void connection().then(listener));
      const unlisten = listen<ConnectionStatus>("connection://status", (e) => listener(e.payload));
      return () => {
        statusListeners.delete(listener);
        offState();
        void unlisten.then((off) => off());
      };
    },
  };
}
