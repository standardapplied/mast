import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectionStatus } from "../../shared/sail-models";
import { createTauriGateway } from "./gateway";

/**
 * Wire contract for the stop lane: every call is one `sail_request` invoke that
 * the Rust core proxies to the devbox, so the method/path/body asserted here
 * are exactly what sail receives.
 */

type Invocation = { cmd: string; args: Record<string, unknown> };

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (...args: unknown[]) => unknown; transformCallback?: () => number };
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

  /** A core that answers each command by name; `plugin:event|listen` is the status subscription. */
  function stubCore(answers: Record<string, (args: Record<string, unknown>) => unknown>): Invocation[] {
    const calls: Invocation[] = [];
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: (cmd: unknown, args: unknown) => {
        const name = cmd as string;
        if (name.startsWith("plugin:event|")) return Promise.resolve(1);
        calls.push({ cmd: name, args: args as Record<string, unknown> });
        const answer = answers[name];
        if (!answer) return Promise.reject(`unexpected command ${name}`);
        try {
          return Promise.resolve(answer(args as Record<string, unknown>));
        } catch (refusal) {
          return Promise.reject(refusal);
        }
      },
    } as TauriWindow["__TAURI_INTERNALS__"];
    return calls;
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

  test("a token the box refuses is the core's to handle: it is told once, never logged out, and its status is pushed", async () => {
    let refused = false;
    const calls = stubCore({
      sail_request: () => refusedToken,
      token_refused: () => {
        refused = true;
        return null;
      },
      connection_status: () =>
        refused
          ? { phase: "unpaired", server: "127.0.0.1:7070", sshHost: "34.1.2.3", paired: true, tokenPresent: false, tokenKind: "none", detail: REVOKED }
          : { phase: "ready", server: "127.0.0.1:7070", sshHost: "34.1.2.3", paired: true, tokenPresent: true, tokenKind: "api" },
    });
    const gateway = createTauriGateway();
    const revoked = new Promise<ConnectionStatus>((resolve) => {
      gateway.onConnectionStatus((status) => {
        if (status.phase === "unpaired") resolve(status);
      });
    });

    const [first, second] = await Promise.all([gateway.whoami(), gateway.listProjects()]);
    expect(first.ok || second.ok).toBe(false);

    expect(await revoked).toMatchObject({ phase: "unpaired", paired: true, host: "34.1.2.3", detail: REVOKED });
    expect(calls.filter((call) => call.cmd === "token_refused")).toHaveLength(1);
    expect(calls.some((call) => call.cmd === "logout")).toBe(false);
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
      forget_box: () => null,
    });
    const gateway = createTauriGateway();

    expect(await gateway.previewConnectCode("sail1.good")).toEqual({
      ok: true,
      value: { handle: "ada", email: "ada@example.com", host: "34.1.2.3" },
    });
    expect(await gateway.previewConnectCode("nope")).toEqual({
      ok: false,
      detail: "That does not look like a connect code; paste the whole code, starting with sail1.",
    });
    expect(await gateway.pair("sail1.good")).toEqual({ ok: false, detail: sentence });
    expect(await gateway.forgetBox()).toEqual({ ok: true });
    expect(calls.map((call) => [call.cmd, call.args])).toEqual([
      ["connect_code_preview", { code: "sail1.good" }],
      ["connect_code_preview", { code: "nope" }],
      ["pair", { code: "sail1.good" }],
      ["forget_box", {}],
    ]);
  });
});
