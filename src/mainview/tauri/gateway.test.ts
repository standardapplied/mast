import { afterEach, describe, expect, test } from "bun:test";
import { createTauriGateway } from "./gateway";

/**
 * Wire contract for the stop lane: every call is one `sail_request` invoke that
 * the Rust core proxies to the devbox, so the method/path/body asserted here
 * are exactly what sail receives.
 */

type Invocation = { cmd: string; args: Record<string, unknown> };

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (...args: unknown[]) => unknown } };

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
    await gateway.invite("room 1", { agent: "claude-code" });

    expect(calls.map((call) => [call.args.method, call.args.path])).toEqual([
      ["GET", "/v1/rooms"],
      ["GET", "/v1/rooms?project=chorus"],
      ["POST", "/v1/rooms"],
      ["GET", "/v1/rooms/room%201"],
      ["DELETE", "/v1/rooms/room%201"],
      ["POST", "/v1/rooms/room%201/members"],
      ["DELETE", "/v1/rooms/room%201/members"],
      ["POST", "/v1/rooms/room%201/invite"],
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
