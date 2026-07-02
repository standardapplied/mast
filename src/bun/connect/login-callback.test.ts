import { describe, expect, test } from "bun:test";
import { loginUrl, newState, startCallbackServer, type ServeDeps } from "./login-callback";

function fakeServe() {
  let handler: ((req: Request) => Response) | null = null;
  let stopped = false;
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  const deps: ServeDeps = {
    serve: (h) => {
      handler = h;
      return {
        port: 45321,
        stop: () => {
          stopped = true;
        },
      };
    },
    schedule: (fn, _ms) => {
      const entry = { fn, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    deps,
    request: (path: string) => handler!(new Request(`http://127.0.0.1:45321${path}`)),
    fireTimers: () => {
      const due = timers.filter((t) => !t.cancelled);
      timers.length = 0;
      due.forEach((t) => t.fn());
    },
    isStopped: () => stopped,
  };
}

describe("login callback server", () => {
  test("accepts the matching state exactly once and resolves the token", async () => {
    const f = fakeServe();
    const state = newState();
    const handle = startCallbackServer(state, f.deps);

    const ok = f.request(`/callback?token=sess_abc123&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await handle.result).toEqual({ token: "sess_abc123" });

    const again = f.request(`/callback?token=sess_other&state=${state}`);
    expect(again.status).toBe(410);
  });

  test("a wrong-state probe is rejected but does NOT cancel the pending sign-in", async () => {
    const f = fakeServe();
    const state = newState();
    const handle = startCallbackServer(state, f.deps);

    // A stray loopback probe with a bad state must not settle the result.
    const bad = f.request(`/callback?token=sess_abc&state=${"0".repeat(32)}`);
    expect(bad.status).toBe(400);

    // The real callback still succeeds afterwards.
    const ok = f.request(`/callback?token=sess_real&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await handle.result).toEqual({ token: "sess_real" });
  });

  test("a non-sess token probe is rejected without settling", async () => {
    const f = fakeServe();
    const state = newState();
    const handle = startCallbackServer(state, f.deps);

    expect(f.request("/robots.txt").status).toBe(404);
    expect(f.request(`/callback?token=notasession&state=${state}`).status).toBe(400);

    const ok = f.request(`/callback?token=sess_ok&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await handle.result).toEqual({ token: "sess_ok" });
  });

  test("state comparison survives a byte-length mismatch without throwing", async () => {
    const f = fakeServe();
    const handle = startCallbackServer("a".repeat(32), f.deps);
    // "é" is 2 UTF-8 bytes but 1 UTF-16 unit — must not throw in timingSafeEqual.
    const res = f.request(`/callback?token=sess_x&state=${encodeURIComponent("é".repeat(32))}`);
    expect(res.status).toBe(400);
    const ok = f.request(`/callback?token=sess_ok&state=${"a".repeat(32)}`);
    expect(ok.status).toBe(200);
    expect(await handle.result).toEqual({ token: "sess_ok" });
  });

  test("cancel settles the result with an error and tears down", async () => {
    const f = fakeServe();
    const handle = startCallbackServer(newState(), f.deps);
    handle.cancel();
    const result = await handle.result;
    expect("error" in result && result.error).toContain("cancelled");
    expect(f.isStopped()).toBe(true);
  });

  test("times out into an error and stops the listener", async () => {
    const f = fakeServe();
    const handle = startCallbackServer(newState(), f.deps);
    f.fireTimers();
    const result = await handle.result;
    expect("error" in result && result.error).toContain("timed out");
    expect(f.isStopped()).toBe(true);
  });

  test("state nonces are 32 hex chars and unique", () => {
    const a = newState();
    const b = newState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  test("loginUrl points at the canonical origin with loopback redirect", () => {
    const url = new URL(loginUrl("http://localhost:7070", 45321, "abc"));
    expect(url.origin).toBe("http://localhost:7070");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:45321/callback");
    expect(url.searchParams.get("state")).toBe("abc");
  });
});
