import { describe, expect, test } from "bun:test";
import type { SailResult } from "../shared/types";
import { createRpcGateway } from "./gateway";

type Bridge = Parameters<typeof createRpcGateway>[0];

function bridgeWith(sailBoard: () => Promise<SailResult<unknown>>): Bridge {
  return { api: { sailBoard } } as unknown as Bridge;
}

// Immediate sleep — no real delay in tests.
const noSleep = () => Promise.resolve();

const ok: SailResult<unknown> = { ok: true, value: { done: 1 } };
const transient: SailResult<unknown> = { ok: false, error: { status: 0, code: "timeout", message: "x" } };
const authErr: SailResult<unknown> = { ok: false, error: { status: 403, code: "forbidden", message: "x" } };

describe("RPC gateway retry (bridge blips are transient, not real network failures)", () => {
  test("retries a status-0 result and returns the eventual success", async () => {
    let calls = 0;
    const gateway = createRpcGateway(
      bridgeWith(async () => {
        calls++;
        return calls < 3 ? transient : ok;
      }),
      noSleep,
    );
    const result = await gateway.board();
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("recovers from a rejecting bridge call", async () => {
    let calls = 0;
    const gateway = createRpcGateway(
      bridgeWith(async () => {
        calls++;
        if (calls < 2) throw new Error("bridge socket closed");
        return ok;
      }),
      noSleep,
    );
    const result = await gateway.board();
    expect(result.ok).toBe(true);
  });

  test("does NOT retry a real API error (non-zero status)", async () => {
    let calls = 0;
    const gateway = createRpcGateway(
      bridgeWith(async () => {
        calls++;
        return authErr;
      }),
      noSleep,
    );
    const result = await gateway.board();
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("gives up after the attempt cap and surfaces a bridge error", async () => {
    const gateway = createRpcGateway(bridgeWith(async () => transient), noSleep);
    const result = await gateway.board();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(0);
  });
});
