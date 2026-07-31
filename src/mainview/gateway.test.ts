import { describe, expect, test } from "bun:test";
import { createDemoGateway } from "./gateway";

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
});

describe("spec runs", () => {
  test("the demo gateway serves a running build run for an in-progress spec", async () => {
    const result = await createDemoGateway().listRuns("chorus-invoice-ui");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const run = result.value.runs.find((r) => r.role === "build");
      expect(run?.status).toBe("running");
      expect(run?.branch).toBe("agent/chorus-invoice-ui");
    }
  });

  test("a spec with no active work has no runs", async () => {
    const result = await createDemoGateway().listRuns("chorus-onboarding");
    expect(result.ok && result.value.runs).toEqual([]);
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
