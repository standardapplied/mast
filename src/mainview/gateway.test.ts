import { describe, expect, test } from "bun:test";
import type { SailResult } from "../shared/types";
import { createDemoGateway, createRpcGateway } from "./gateway";

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

describe("project roster", () => {
  test("the demo gateway serves the full catalog with container states", async () => {
    const result = await createDemoGateway().listProjects();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projects.map((p) => p.name)).toEqual(["chorus", "nautilus", "sail-mast"]);
      expect(result.value.projects.map((p) => p.container_status)).toEqual([
        "running",
        "not_created",
        "stopped",
      ]);
    }
  });

  test("the retired Electrobun bridge reports the roster as unsupported", async () => {
    const gateway = createRpcGateway(bridgeWith(async () => ok), noSleep);
    const result = await gateway.listProjects();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported");
  });
});

describe("FDE roster", () => {
  test("the demo gateway serves the org's FDEs with handles and display names", async () => {
    const result = await createDemoGateway().listFdes();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fdes.map((f) => f.handle)).toEqual(["ravi", "sumesh", "uday"]);
      expect(result.value.fdes.every((f) => f.role)).toBe(true);
    }
  });

  test("the retired Electrobun bridge reports the FDE roster as unsupported", async () => {
    const gateway = createRpcGateway(bridgeWith(async () => ok), noSleep);
    const result = await gateway.listFdes();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported");
  });
});

describe("review findings", () => {
  test("the demo gateway serves a review's findings consistent with its counts", async () => {
    const gateway = createDemoGateway();
    const reviews = await gateway.specReviews("chorus-rate-limits");
    expect(reviews.ok && reviews.value.reviews[0]?.id).toBe("rev-1");

    const detail = await gateway.reviewDetail("rev-1");
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      const counted = reviews.ok
        ? reviews.value.reviews[0]!.stages.reduce((n, s) => n + s.finding_count, 0)
        : -1;
      expect(detail.value.findings.length).toBe(counted);
      expect(detail.value.findings.every((f) => f.severity && f.title && f.description)).toBe(true);
    }
  });

  test("an unknown review id is a 404, not a crash", async () => {
    const result = await createDemoGateway().reviewDetail("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(404);
  });
});

describe("spec body edits go through the content resource", () => {
  test("putSpecContent updates the body and getSpecContent reflects it", async () => {
    const gateway = createDemoGateway();
    const put = await gateway.putSpecContent("chorus-billing-export", { body: "# Rewritten body" });
    expect(put.ok).toBe(true);

    const after = await gateway.getSpecContent("chorus-billing-export");
    expect(after.ok && after.value.body).toBe("# Rewritten body");
  });

  test("a stale If-Match is a 412 conflict, not a silent overwrite", async () => {
    const gateway = createDemoGateway();
    const result = await gateway.putSpecContent("chorus-billing-export", { body: "x" }, '"stale"');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.status).toBe(412);
  });
});
