/**
 * Loopback callback receiver for the passkey ceremony, mirroring the CLI's
 * LoopbackCallbackServer: the system browser is sent to
 * {origin}/login?redirect_uri=http://127.0.0.1:PORT/callback&state=NONCE,
 * completes Touch ID against /v1/auth/login/*, and the server redirects back
 * here with ?token=sess_...&state=NONCE.
 *
 * Hardening: binds 127.0.0.1 only; accepts exactly one GET /callback; the
 * state nonce is compared in constant time; the token is resolved once and
 * never logged; every other request gets 404 with no detail; the listener
 * dies after first use or timeout.
 */

import { timingSafeEqual } from "node:crypto";

export type CallbackResult = { token: string } | { error: string };

export type CallbackServerHandle = {
  port: number;
  result: Promise<CallbackResult>;
  stop: () => void;
};

export type ServeDeps = {
  serve: (handler: (req: Request) => Response) => { port: number; stop: () => void };
  schedule: (fn: () => void, ms: number) => () => void;
};

const DEFAULT_TIMEOUT_MS = 180_000;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Mast</title>
<body style="font-family: ui-monospace, monospace; background: #0a0e11; color: #f6f1e9;
display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0">
<p>Signed in — return to Mast.</p></body>`;

export function defaultServeDeps(): ServeDeps {
  return {
    serve: (handler) => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
      if (server.port === undefined) throw new Error("Callback listener failed to bind");
      return { port: server.port, stop: () => void server.stop(true) };
    },
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
}

export function newState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stateMatches(expected: string, received: string | null): boolean {
  if (!received || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function startCallbackServer(
  state: string,
  deps: ServeDeps = defaultServeDeps(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
): CallbackServerHandle {
  let settle: (result: CallbackResult) => void = () => {};
  let settled = false;
  const result = new Promise<CallbackResult>((resolve) => {
    settle = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
  });

  const server = deps.serve((req) => {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/callback") {
      return new Response("Not found", { status: 404 });
    }
    if (settled) return new Response("Gone", { status: 410 });

    if (!stateMatches(state, url.searchParams.get("state"))) {
      settle({ error: "State mismatch — possible interception; sign-in aborted." });
      return new Response("Bad request", { status: 400 });
    }
    const token = url.searchParams.get("token");
    if (!token || !token.startsWith("sess_")) {
      settle({ error: "Callback carried no session token." });
      return new Response("Bad request", { status: 400 });
    }
    settle({ token });
    return new Response(DONE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  });

  const cancelTimeout = deps.schedule(() => {
    settle({ error: "Sign-in timed out." });
    server.stop();
  }, timeoutMs);

  void result.then(() => {
    cancelTimeout();
    deps.schedule(() => server.stop(), 1000);
  });

  return { port: server.port, result, stop: () => server.stop() };
}

export function loginUrl(origin: string, callbackPort: number, state: string): string {
  const url = new URL("/login", origin);
  url.searchParams.set("redirect_uri", `http://127.0.0.1:${callbackPort}/callback`);
  url.searchParams.set("state", state);
  return url.toString();
}
