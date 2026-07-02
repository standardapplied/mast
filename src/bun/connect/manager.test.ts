import { describe, expect, test } from "bun:test";
import type { EventStreamState } from "../../shared/sail-models";
import type { TunnelState } from "./tunnel";
import { ConnectionManager, type ConnectionStatus, type ManagerDeps } from "./manager";

type Verdict = "ok" | "unauthenticated" | "unreachable";

function harness(opts: {
  token?: string | null;
  probeHealthy?: boolean | (() => boolean);
  sshHost?: string | null;
  verdict?: Verdict;
  callbackResult?: { token: string } | { error: string };
}) {
  const tunnelListeners = new Set<(s: TunnelState) => void>();
  const streamStarts: string[] = [];
  const written: string[] = [];
  const opened: string[] = [];
  const stacks: Array<[string, string | null]> = [];
  const supervisors: Array<() => void> = [];
  let verdict: Verdict = opts.verdict ?? "ok";
  const probeHealthy = () =>
    typeof opts.probeHealthy === "function" ? opts.probeHealthy() : (opts.probeHealthy ?? true);

  const deps: ManagerDeps = {
    config: () => ({
      server: "http://127.0.0.1:7070",
      loginOrigin: "http://localhost:7070",
      token: opts.token === undefined ? "sail_tok" : opts.token,
    }),
    sshHost: () => (opts.sshHost === undefined ? "devbox" : opts.sshHost),
    probe: async () => probeHealthy(),
    validateToken: async () => verdict,
    makeTunnel: () => ({
      start: async () => {},
      stop: () => {},
      onState: (l) => {
        tunnelListeners.add(l);
        return () => tunnelListeners.delete(l);
      },
    }),
    makeStream: (server) => {
      streamStarts.push(server);
      return {
        start: async () => {},
        stop: () => {},
        onState: (l: (s: EventStreamState) => void) => {
          l("connected");
          return () => {};
        },
        onEvent: () => () => {},
      };
    },
    writeToken: (t) => void written.push(t),
    openExternal: (url) => void opened.push(url),
    startCallback: () => ({
      port: 45321,
      result: Promise.resolve(opts.callbackResult ?? { token: "sess_new" }),
      cancel: () => {},
      stop: () => {},
    }),
    onStack: (server, token) => void stacks.push([server, token]),
    onEvent: () => {},
    scheduleSupervisor: (fn) => {
      supervisors.push(fn);
      return () => {};
    },
  };

  const manager = new ConnectionManager(deps);
  const statuses: ConnectionStatus[] = [];
  manager.onStatus((s) => statuses.push(s));

  return {
    manager,
    statuses,
    streamStarts,
    written,
    opened,
    stacks,
    tunnelUp: (server: string) =>
      tunnelListeners.forEach((l) => l({ phase: "up", port: 7070, server })),
    tunnelBackoff: () =>
      tunnelListeners.forEach((l) => l({ phase: "backoff", retryInMs: 1000, lastError: "ssh died" })),
    fireSupervisor: () => supervisors.forEach((fn) => fn()),
    setVerdict: (v: Verdict) => {
      verdict = v;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("ConnectionManager", () => {
  test("direct mode: healthy server + valid token → ready with live stream", async () => {
    const h = harness({ probeHealthy: true });
    await h.manager.start();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");
    expect(h.manager.currentStatus.stream).toBe("connected");
    expect(h.streamStarts).toEqual(["http://127.0.0.1:7070"]);
  });

  test("unreachable + host → tunnel; ready once the tunnel is up", async () => {
    const h = harness({ probeHealthy: false });
    await h.manager.start();
    expect(h.manager.currentStatus.phase).toBe("tunnel-connecting");

    h.tunnelUp("http://127.0.0.1:52700");
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");
    expect(h.manager.currentStatus.server).toBe("http://127.0.0.1:52700");
    expect(h.stacks.at(-1)).toEqual(["http://127.0.0.1:52700", "sail_tok"]);
  });

  test("unreachable + no host → no-host with guidance", async () => {
    const h = harness({ probeHealthy: false, sshHost: null });
    await h.manager.start();
    expect(h.manager.currentStatus.phase).toBe("no-host");
    expect(h.manager.currentStatus.detail).toContain("config.yaml");
  });

  test("expired session → unauthenticated, not an error wall", async () => {
    const h = harness({ verdict: "unauthenticated" });
    await h.manager.start();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("unauthenticated");
    expect(h.manager.currentStatus.detail).toContain("sign in");
  });

  test("no token at all → unauthenticated immediately, no validation call", async () => {
    const h = harness({ token: null });
    await h.manager.start();
    expect(h.manager.currentStatus.phase).toBe("unauthenticated");
    expect(h.manager.currentStatus.tokenPresent).toBe(false);
  });

  test("login ceremony: browser opened at canonical origin, token persisted, ready", async () => {
    const h = harness({ token: null });
    await h.manager.start();

    h.setVerdict("ok");
    const result = await h.manager.login();
    await flush();

    expect(result.ok).toBe(true);
    expect(h.opened[0]).toContain("http://localhost:7070/login?");
    expect(h.opened[0]).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A45321%2Fcallback");
    expect(h.written).toEqual(["sess_new"]);
    expect(h.manager.currentStatus.phase).toBe("ready");
  });

  test("login fails fast when the tunnel port differs from the ceremony origin", async () => {
    const h = harness({ token: null, probeHealthy: false });
    await h.manager.start();
    h.tunnelUp("http://127.0.0.1:52814");
    await flush();

    const result = await h.manager.login();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("7070 is busy");
    expect(h.opened).toEqual([]);
  });

  test("login failure surfaces the callback error and stays unauthenticated", async () => {
    const h = harness({ token: null, callbackResult: { error: "Sign-in timed out." } });
    await h.manager.start();
    const result = await h.manager.login();
    expect(result).toEqual({ ok: false, detail: "Sign-in timed out." });
    expect(h.written).toEqual([]);
    expect(h.manager.currentStatus.phase).toBe("unauthenticated");
  });

  test("mid-session auth error flips ready → unauthenticated and stops the stream", async () => {
    const h = harness({});
    await h.manager.start();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");

    h.manager.onAuthError();
    expect(h.manager.currentStatus.phase).toBe("unauthenticated");
    expect(h.manager.currentStatus.stream).toBe("disconnected");
  });

  test("tunnel dropping degrades honestly and recovers on the next up", async () => {
    const h = harness({ probeHealthy: false });
    await h.manager.start();
    h.tunnelUp("http://127.0.0.1:52700");
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");

    h.tunnelBackoff();
    expect(h.manager.currentStatus.phase).toBe("tunnel-degraded");

    h.tunnelUp("http://127.0.0.1:52701");
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");
    expect(h.manager.currentStatus.server).toBe("http://127.0.0.1:52701");
  });

  test("a transient 'unreachable' verdict self-heals when the supervisor fires", async () => {
    let up = true;
    const h = harness({ probeHealthy: () => up, verdict: "unreachable" });
    await h.manager.start();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("tunnel-degraded");

    h.setVerdict("ok");
    h.fireSupervisor();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");
    void up;
  });

  test("no-host re-probes and recovers when the server later comes up", async () => {
    let reachable = false;
    const h = harness({ probeHealthy: () => reachable, sshHost: null });
    await h.manager.start();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("no-host");

    reachable = true;
    h.fireSupervisor();
    await flush();
    expect(h.manager.currentStatus.phase).toBe("ready");
  });

  test("a stale tunnel 'up' cannot revive a superseded generation", async () => {
    const h = harness({ probeHealthy: false, verdict: "ok" });
    await h.manager.start();
    // Stop supersedes everything; a late tunnelUp must be ignored.
    h.manager.stop();
    h.tunnelUp("http://127.0.0.1:52700");
    await flush();
    expect(h.manager.currentStatus.phase).not.toBe("ready");
  });
});
