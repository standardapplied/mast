import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectionStatus } from "../../shared/sail-models";
import { unbindPage } from "./core";
import { createTauriGateway } from "./gateway";

/**
 * Wire contract for the stop lane: every call is one `sail_request` invoke that
 * the Rust core proxies to the devbox, so the method/path/body asserted here
 * are exactly what sail receives.
 */

type Invocation = { cmd: string; args: Record<string, unknown>; backend?: string };

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (...args: unknown[]) => unknown;
    transformCallback?: (callback: (event: { payload: unknown }) => void) => number;
  };
};

function stubInvoke(response: { status: number; body: string }): Invocation[] {
  const calls: Invocation[] = [];
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd: unknown, args: unknown) => {
      calls.push({ cmd: cmd as string, args: args as Record<string, unknown> });
      return Promise.resolve({ status: response.status, etag: null, body: response.body });
    },
  };
  return calls;
}

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  unbindPage();
});

describe("Tauri gateway stop wire", () => {
  test("stopRun POSTs /v1/runs/{id}/stop with an empty body and parses the outcome", async () => {
    const calls = stubInvoke({
      status: 200,
      body: JSON.stringify({ run_id: "run 1", stopped: true, spec_cancelled: true }),
    });

    const result = await createTauriGateway().stopRun("run 1");

    expect(calls).toEqual([
      {
        cmd: "sail_request",
        args: { method: "POST", path: "/v1/runs/run%201/stop", body: null, ifMatch: null },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ run_id: "run 1", stopped: true, spec_cancelled: true });
    }
  });

  test("a structured API error keeps its code, message, and action", async () => {
    stubInvoke({
      status: 404,
      body: JSON.stringify({
        schema_version: 1,
        error: { code: "not_found", message: "No route", action: "Upgrade sail" },
      }),
    });

    const result = await createTauriGateway().stopRun("run-9");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        status: 404,
        code: "not_found",
        message: "No route",
        action: "Upgrade sail",
      });
    }
  });
});

describe("Tauri gateway room wire", () => {
  test("creates a draft spec through the existing POST /v1/specs route", async () => {
    const calls = stubInvoke({
      status: 201,
      body: JSON.stringify({ spec: { id: "fresh-room" } }),
    });

    await createTauriGateway().createSpec({
      id: "fresh-room",
      project: "mast",
      title: "Fresh room",
      status: "draft",
      body: "",
    });

    expect(calls).toEqual([
      {
        cmd: "sail_request",
        args: {
          method: "POST",
          path: "/v1/specs",
          body: JSON.stringify({
            id: "fresh-room",
            project: "mast",
            title: "Fresh room",
            status: "draft",
            body: "",
          }),
          ifMatch: null,
        },
      },
    ]);
  });

  test("lists and posts messages through the room door with encoded ids", async () => {
    const calls = stubInvoke({
      status: 200,
      body: JSON.stringify({ spec_id: "spec 1", messages: [], total: 0 }),
    });
    const gateway = createTauriGateway();

    await gateway.listSpecMessages("spec 1", { before: "message/1", limit: 100 });
    await gateway.listSpecMessages("spec 1", { after: "message/2", limit: 100 });
    await gateway.postSpecMessage("spec 1", { body: "hello" });

    expect(calls).toEqual([
      {
        cmd: "sail_request",
        args: {
          method: "GET",
          path: "/v1/rooms/spec%201/messages?before=message%2F1&limit=100",
          body: null,
          ifMatch: null,
        },
      },
      {
        cmd: "sail_request",
        args: {
          method: "GET",
          path: "/v1/rooms/spec%201/messages?after=message%2F2&limit=100",
          body: null,
          ifMatch: null,
        },
      },
      {
        cmd: "sail_request",
        args: {
          method: "POST",
          path: "/v1/rooms/spec%201/messages",
          body: JSON.stringify({ body: "hello" }),
          ifMatch: null,
        },
      },
    ]);
  });

  test("rooms are their own resource with membership on the room door", async () => {
    const calls = stubInvoke({ status: 200, body: "{}" });
    const gateway = createTauriGateway();

    await gateway.listRooms();
    await gateway.listRooms("chorus");
    await gateway.createRoom({ id: "room 1", project: "chorus", title: "Room 1" });
    await gateway.getRoom("room 1");
    await gateway.deleteRoom("room 1");
    await gateway.engage("room 1", { agent: "claude-code" });
    await gateway.disengage("room 1");

    expect(calls.map((call) => [call.args.method, call.args.path])).toEqual([
      ["GET", "/v1/rooms"],
      ["GET", "/v1/rooms?project=chorus"],
      ["POST", "/v1/rooms"],
      ["GET", "/v1/rooms/room%201"],
      ["DELETE", "/v1/rooms/room%201"],
      ["POST", "/v1/rooms/room%201/members"],
      ["DELETE", "/v1/rooms/room%201/members"],
    ]);
  });

  test("wires review decisions and recent event reconciliation", async () => {
    const calls = stubInvoke({ status: 200, body: "{}" });
    const gateway = createTauriGateway();

    await gateway.approveReview("review 1");
    await gateway.dismissFinding("review 1", "finding/1");
    await gateway.recentEvents(100);

    expect(calls.map((call) => call.args.path)).toEqual([
      "/v1/reviews/review%201/approve",
      "/v1/reviews/review%201/dismiss/finding%2F1",
      "/v1/events/recent?limit=100",
    ]);
  });

  test("scopes spec event history to the spec with the exclusive since cursor", async () => {
    const calls = stubInvoke({ status: 200, body: "{}" });
    const gateway = createTauriGateway();

    await gateway.specEvents("spec 1", { limit: 100 });
    await gateway.specEvents("spec 1", { since: 42 });
    await gateway.specEvents("spec 1");

    expect(calls.map((call) => call.args.path)).toEqual([
      "/v1/events?spec=spec+1&limit=100",
      "/v1/events?spec=spec+1&since=42",
      "/v1/events?spec=spec+1",
    ]);
  });
});

describe("Tauri gateway log wire", () => {
  test("a fix run's log is read from the newest fix run through the run log route", async () => {
    const run = (id: string, role: string, startedAt: string) => ({
      id,
      project: "mast",
      spec_id: "spec 1",
      node: "main",
      role,
      agent: "claude-code",
      status: "completed",
      started_at: startedAt,
      ...(role === "build" ? {} : { review_id: "rev-1" }),
    });
    const paths: string[] = [];
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: (_cmd: unknown, args: unknown) => {
        const path = (args as { path: string }).path;
        paths.push(path);
        const body = path.startsWith("/v1/runs?")
          ? {
              runs: [
                run("run-build", "build", "2026-10-03T10:00:00Z"),
                run("run-fix-1", "fix", "2026-10-03T10:20:00Z"),
                run("run-fix-2", "fix", "2026-10-03T10:40:00Z"),
                run("run-review-2", "review", "2026-10-03T10:50:00Z"),
              ],
            }
          : { run_id: "run-fix-2", lines: ["fixing"] };
        return Promise.resolve({ status: 200, etag: null, body: JSON.stringify(body) });
      },
    };

    const result = await createTauriGateway().agentLogSnapshot("spec 1", "fix", 200);

    expect(paths).toEqual(["/v1/runs?spec=spec%201", "/v1/runs/run-fix-2/log?tail=200"]);
    expect(result.ok && result.value.lines).toEqual(["fixing"]);
  });
});

describe("Tauri gateway prune wire", () => {
  test("pruneSpecs POSTs /v1/specs:prune with the selection and the dry-run flag", async () => {
    const report = {
      dry_run: true,
      requested: false,
      specs: 1,
      rooms: 1,
      messages: 0,
      runs: 0,
      reviews: 0,
      files: 0,
      projects: 0,
      events: 0,
      blob_bytes: 12,
      entries: [{ type: "spec", id: "old" }],
    };
    const calls = stubInvoke({ status: 200, body: JSON.stringify(report) });

    const result = await createTauriGateway().pruneSpecs({ ids: ["old"], dry_run: true });

    expect(calls).toEqual([
      {
        cmd: "sail_request",
        args: {
          method: "POST",
          path: "/v1/specs:prune",
          body: JSON.stringify({ ids: ["old"], dry_run: true }),
          ifMatch: null,
        },
      },
    ]);
    expect(result).toEqual({ ok: true, value: report, etag: undefined });
  });
});

describe("Tauri gateway pairing wire", () => {
  const REVOKED = "This code was revoked on the box; ask for a new one.";
  const refusedToken = {
    status: 403,
    etag: null,
    body: JSON.stringify({
      schema_version: 1,
      error: { code: "invalid_bearer_token", message: "Bearer token is invalid." },
    }),
  };

  const ready = {
    phase: "ready",
    server: "127.0.0.1:7070",
    sshHost: "34.1.2.3",
    paired: true,
    tokenPresent: true,
    tokenKind: "api",
  };
  const revoked = { ...ready, phase: "unpaired", tokenPresent: false, tokenKind: "none", detail: REVOKED };

  /** Speaks as the core on a Tauri event the gateway is listening to. */
  let emit: (event: string, payload: unknown) => void = () => {};

  const flush = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  /** A core that answers each command by name and delivers what `emit` says to whoever listens. */
  function stubCore(answers: Record<string, (args: Record<string, unknown>) => unknown>): Invocation[] {
    const calls: Invocation[] = [];
    const callbacks: Array<(event: { payload: unknown }) => void> = [];
    const listening = new Map<string, number>();
    emit = (event, payload) => {
      const handler = listening.get(event);
      if (handler !== undefined) callbacks[handler]!({ payload });
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event) => listening.delete(event) };
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      transformCallback: (callback) => callbacks.push(callback) - 1,
      invoke: (cmd: unknown, args: unknown, options: unknown) => {
        const name = cmd as string;
        const given = args as Record<string, unknown>;
        if (name === "plugin:event|listen") listening.set(given.event as string, given.handler as number);
        if (name.startsWith("plugin:event|")) return Promise.resolve(given.handler ?? null);
        const backend = (options as { headers: Record<string, string> }).headers["x-mast-backend"];
        calls.push({ cmd: name, args: given, ...(backend === undefined ? {} : { backend }) });
        const answer = answers[name];
        if (!answer) return Promise.reject(`unexpected command ${name}`);
        try {
          return Promise.resolve(answer(given));
        } catch (refusal) {
          return Promise.reject(refusal);
        }
      },
    };
    return calls;
  }

  /** A page restart as the gateway asks for it: counted, and never settled. */
  function restarts(): { count: number; restart: () => Promise<never> } {
    const seen = {
      count: 0,
      restart: () => {
        seen.count += 1;
        return new Promise<never>(() => {});
      },
    };
    return seen;
  }

  test("a fresh Mac reads as unpaired, and a paired one names its box", async () => {
    stubCore({
      connection_status: () => ({
        phase: "unpaired",
        server: "",
        paired: false,
        tokenPresent: false,
        tokenKind: "none",
        detail: null,
      }),
    });
    const fresh = await createTauriGateway().connection();
    expect(fresh.phase).toBe("unpaired");
    expect(fresh.paired).toBe(false);
    expect(fresh.detail).toBeUndefined();

    stubCore({
      connection_status: () => ({
        phase: "unpaired",
        server: "127.0.0.1:7070",
        sshHost: "34.1.2.3",
        paired: true,
        tokenPresent: false,
        tokenKind: "none",
        detail: REVOKED,
      }),
    });
    const revoked = await createTauriGateway().connection();
    expect(revoked).toMatchObject({ phase: "unpaired", paired: true, host: "34.1.2.3", detail: REVOKED });
  });

  test("a status says which SSH port its box is behind and whether a box was forgotten this run", async () => {
    stubCore({ connection_status: () => ({ ...ready, backend: 4, sshPort: 2222, forgotten: true }) });
    expect(await createTauriGateway().connection()).toMatchObject({ host: "34.1.2.3", sshPort: 2222, forgotten: true });
    unbindPage();

    stubCore({ connection_status: () => ({ ...ready, backend: 5, sshHost: "devbox", sshPort: null, paired: false }) });
    const cli = await createTauriGateway().connection();
    expect(cli.sshPort).toBeUndefined();
    expect(cli.forgotten).toBe(false);
  });

  test("a token the box refuses was the core's to act on: the gateway only reads its status again, once, and pushes it", async () => {
    let refused = false;
    const calls = stubCore({
      sail_request: () => {
        refused = true;
        return refusedToken;
      },
      connection_status: () => (refused ? revoked : ready),
    });
    const gateway = createTauriGateway();
    const pushed = new Promise<ConnectionStatus>((resolve) => {
      gateway.onConnectionStatus((status) => {
        if (status.phase === "unpaired") resolve(status);
      });
    });

    const [first, second] = await Promise.all([gateway.whoami(), gateway.listProjects()]);
    expect(first.ok || second.ok).toBe(false);

    expect(await pushed).toMatchObject({ phase: "unpaired", paired: true, host: "34.1.2.3", detail: REVOKED });
    expect(calls.map((call) => call.cmd).sort()).toEqual([
      "connection_status",
      "connection_status",
      "sail_request",
      "sail_request",
    ]);
  });

  test("a command names the backend its page is for, however late it is sent: a kill begun before the box was forgotten cannot be for the next box", async () => {
    let held = 7;
    let answerRoom: (response: unknown) => void = () => {};
    const calls = stubCore({
      connection_status: () => ({ ...ready, backend: held }),
      sail_request: () => new Promise((resolve) => (answerRoom = resolve)),
      session_kill: () => null,
      forget_box: () => {
        held = 8;
        return null;
      },
    });
    const page = restarts();
    const gateway = createTauriGateway(page.restart);
    await gateway.connection();

    const killed = gateway.getRoom("design-talk").then(() => gateway.killSession("room-design-talk"));
    await flush();
    void gateway.forgetBox();
    await flush();
    answerRoom({ status: 200, etag: null, body: "{}" });
    await killed;

    expect(page.count).toBe(1);
    expect(calls.map((call) => [call.cmd, call.backend])).toEqual([
      ["connection_status", undefined],
      ["sail_request", "7"],
      ["forget_box", "7"],
      ["session_kill", "7"],
    ]);
  });

  test("a status from another backend, or from none once the page has one, is never shown: the page starts over", async () => {
    let held: number | undefined = 7;
    stubCore({ connection_status: () => ({ ...ready, backend: held }) });
    const page = restarts();
    const gateway = createTauriGateway(page.restart);
    const shown: ConnectionStatus[] = [];
    gateway.onConnectionStatus((status) => shown.push(status));
    await flush();
    expect(shown.map((status) => status.phase)).toEqual(["ready"]);

    held = 8;
    void gateway.connection().then((status) => shown.push(status));
    await flush();
    expect(page.count).toBe(1);

    held = undefined;
    void gateway.connection().then((status) => shown.push(status));
    await flush();
    expect(page.count).toBe(2);
    expect(shown).toHaveLength(1);
  });

  test("a page that has seen no backend takes the first one a status names, with no restart", async () => {
    let held: number | undefined;
    const calls = stubCore({
      connection_status: () => (held === undefined ? { ...revoked, paired: false } : { ...ready, backend: held }),
      list_targets: () => [],
      sail_request: () => ({ status: 200, etag: null, body: "{}" }),
    });
    const page = restarts();
    const gateway = createTauriGateway(page.restart);
    expect((await gateway.connection()).phase).toBe("unpaired");
    await gateway.whoami();

    held = 3;
    expect((await gateway.connection()).phase).toBe("ready");
    await gateway.whoami();

    expect(page.count).toBe(0);
    expect(calls.filter((call) => call.cmd === "sail_request").map((call) => call.backend)).toEqual([undefined, "3"]);
  });

  test("pairing and forgetting end the page: a success asks for the restart and never settles", async () => {
    stubCore({ pair: () => null, forget_box: () => null });
    const page = restarts();
    const gateway = createTauriGateway(page.restart);
    let settled = false;

    void gateway.pair("sail1.good").then(() => (settled = true));
    await flush();
    expect(page.count).toBe(1);

    void gateway.forgetBox().then(() => (settled = true));
    await flush();
    expect(page.count).toBe(2);
    expect(settled).toBe(false);
  });

  test("preview, pair and forget carry the code in and the core's sentence out", async () => {
    const sentence = "The box at 34.1.2.3 refused this code (Bearer token is invalid); ask for a new one.";
    const calls = stubCore({
      connect_code_preview: ({ code }) => {
        if (code !== "sail1.good") throw "That does not look like a connect code; paste the whole code, starting with sail1.";
        return { handle: "ada", email: "ada@example.com", host: "34.1.2.3" };
      },
      pair: () => {
        throw sentence;
      },
      forget_box: () => {
        throw "Mast could not delete ~/.sail/mast.yaml (permission denied).";
      },
    });
    const page = restarts();
    const gateway = createTauriGateway(page.restart);

    expect(await gateway.previewConnectCode("sail1.good")).toEqual({
      ok: true,
      value: { handle: "ada", email: "ada@example.com", host: "34.1.2.3" },
    });
    expect(await gateway.previewConnectCode("nope")).toEqual({
      ok: false,
      detail: "That does not look like a connect code; paste the whole code, starting with sail1.",
    });
    expect(await gateway.pair("sail1.good")).toEqual({ detail: sentence });
    expect(await gateway.forgetBox()).toEqual({ detail: "Mast could not delete ~/.sail/mast.yaml (permission denied)." });
    expect(page.count, "a refusal leaves the page where it was").toBe(0);
    expect(calls.map((call) => [call.cmd, call.args])).toEqual([
      ["connect_code_preview", { code: "sail1.good" }],
      ["connect_code_preview", { code: "nope" }],
      ["pair", { code: "sail1.good" }],
      ["forget_box", {}],
    ]);
  });
});
