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
