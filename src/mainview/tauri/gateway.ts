import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ApiErrorBody,
  ConnectionStatus,
  SailEvent,
  SpecFilter,
} from "../../shared/sail-models";
import type { SailResult, SailWireError } from "../../shared/types";
import type { Gateway } from "../gateway";

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

async function read<T>(
  method: string,
  path: string,
  opts: { body?: unknown; ifMatch?: string } = {},
): Promise<SailResult<T>> {
  let response: RustResponse;
  try {
    response = await sailRequest(method, path, opts);
  } catch (error) {
    return { ok: false, error: { status: 0, code: "bridge", message: String(error) } };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: parseError(response.status, response.body) };
  }
  const value = (response.body ? JSON.parse(response.body) : {}) as T;
  return { ok: true, value, etag: response.etag ?? undefined };
}

export function createTauriGateway(): Gateway {
  return {
    listSpecs: (filter = {}) => read("GET", `/v1/specs${queryString(filter)}`),
    board: (project) => read("GET", `/v1/specs/board${queryString({ project })}`),
    getSpec: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}`),
    getSpecContent: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}/content`),
    updateSpec: (id, request, ifMatch) =>
      read("PUT", `/v1/specs/${encodeURIComponent(id)}`, { body: request, ifMatch }),
    specHistory: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}/history`),
    restoreSpec: (id, rev) =>
      read("POST", `/v1/specs/${encodeURIComponent(id)}/restore`, { body: { rev } }),
    specReviews: (id) => read("GET", `/v1/specs/${encodeURIComponent(id)}/reviews`),
    dispatch: (project, request) =>
      read("POST", `/v1/projects/${encodeURIComponent(project)}/dispatch`, { body: request }),
    whoami: () => read("GET", "/v1/whoami"),

    async connection(): Promise<ConnectionStatus> {
      try {
        const raw = await invoke<RawStatus>("connection_status");
        return {
          phase: raw.phase === "ready" ? "ready" : raw.phase === "error" ? "failed" : "probing",
          server: raw.server,
          loginOrigin: raw.sshHost ? `ssh://${raw.sshHost}` : raw.server,
          tokenPresent: raw.tokenPresent,
          tokenKind: raw.tokenPresent ? "session" : "none",
          stream: raw.phase === "ready" ? "connected" : "disconnected",
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
    },

    async login() {
      return {
        ok: false,
        detail: "Passkey login on Tauri lands with the loopback ceremony (device follow-up).",
      };
    },

    async diagnostics() {
      const status = await this.connection();
      return {
        report: `=== Mast diagnostics (Tauri) ===\n${JSON.stringify(status, null, 2)}`,
        logPath: "(Tauri backend)",
      };
    },

    onEvent(listener: (event: SailEvent) => void) {
      const unlisten = listen<SailEvent>("sail://event", (e) => listener(e.payload));
      return () => void unlisten.then((off) => off());
    },

    onConnectionStatus(listener: (status: ConnectionStatus) => void) {
      void this.connection().then(listener);
      const unlisten = listen<ConnectionStatus>("connection://status", (e) => listener(e.payload));
      return () => void unlisten.then((off) => off());
    },
  };
}
