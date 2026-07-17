import { describe, expect, test } from "bun:test";
import type { RunView, StopRunResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { mapStopOutcome, noRunningRunMessage, runningBuildRun } from "./stopRun";

const run = (partial: Partial<RunView> & Pick<RunView, "id">): RunView => ({
  project: "chorus",
  spec_id: "s1",
  node: "ravi-box",
  role: "build",
  agent: "claude-code",
  status: "running",
  started_at: "2026-07-15T10:00:00Z",
  ...partial,
});

const target = run({ id: "run-b2" });

const ok = (value: Partial<StopRunResponse>): SailResult<StopRunResponse> => ({
  ok: true,
  value: { run_id: "run-b2", stopped: false, spec_cancelled: false, ...value },
});

const err = (status: number, code: string, message: string): SailResult<StopRunResponse> => ({
  ok: false,
  error: { status, code, message },
});

describe("runningBuildRun", () => {
  test("picks the newest running build run, never review or finished runs", () => {
    const runs = [
      run({ id: "run-b1", started_at: "2026-07-14T10:00:00Z" }),
      run({ id: "run-r1", role: "review", started_at: "2026-07-16T10:00:00Z" }),
      run({ id: "run-b3", status: "completed", started_at: "2026-07-16T09:00:00Z" }),
      run({ id: "run-b2", started_at: "2026-07-15T10:00:00Z" }),
    ];
    expect(runningBuildRun(runs)?.id).toBe("run-b2");
  });

  test("no running build run resolves to undefined, with an honest message ready", () => {
    expect(runningBuildRun([run({ id: "run-b1", status: "failed" })])).toBeUndefined();
    expect(noRunningRunMessage("s1")).toContain("s1");
    expect(noRunningRunMessage("s1")).toContain("another FDE");
  });
});

describe("mapStopOutcome", () => {
  test("stopped: the success toast and a refresh so cancelled appears immediately", () => {
    const toast = mapStopOutcome(ok({ stopped: true, spec_cancelled: true }), target);
    expect(toast).toEqual({ type: "success", message: "Stopped — spec cancelled.", refresh: true });
  });

  test("no_agent_running with the spec rescued still reads as a success", () => {
    const toast = mapStopOutcome(ok({ reason: "no_agent_running", spec_cancelled: true }), target);
    expect(toast.type).toBe("success");
    expect(toast.message).toContain("rescued to cancelled");
    expect(toast.refresh).toBe(true);
  });

  test("no_agent_running without a rescue is an informational no-op", () => {
    const toast = mapStopOutcome(ok({ reason: "no_agent_running" }), target);
    expect(toast.type).toBe("info");
    expect(toast.message).toContain("already gone");
  });

  test("run_not_running: a repeated stop is an idempotent no-op, not an error", () => {
    const toast = mapStopOutcome(ok({ reason: "run_not_running" }), target);
    expect(toast.type).toBe("info");
    expect(toast.message).toContain("run-b2");
    expect(toast.message).toContain("already finished");
    expect(toast.refresh).toBe(true);
  });

  test("run_not_active: a newer attempt owns the agent — refresh and retry", () => {
    const toast = mapStopOutcome(ok({ reason: "run_not_active" }), target);
    expect(toast.type).toBe("info");
    expect(toast.message).toContain("newer attempt");
    expect(toast.refresh).toBe(true);
  });

  test("an unknown refusal reason still yields a friendly toast", () => {
    const toast = mapStopOutcome(ok({ reason: "solar_flare" }), target);
    expect(toast.type).toBe("info");
    expect(toast.message).toContain("solar_flare");
  });

  test("run_on_other_node names the node that owns the run", () => {
    const toast = mapStopOutcome(err(409, "run_on_other_node", "run on other node"), target);
    expect(toast.type).toBe("error");
    expect(toast.message).toContain("ravi-box");
    expect(toast.message).toContain("run-b2");
  });

  test("forbidden_not_assignee explains who may stop", () => {
    const toast = mapStopOutcome(err(403, "forbidden_not_assignee", "forbidden"), target);
    expect(toast.type).toBe("error");
    expect(toast.message).toContain("assignee");
  });

  test("a 404 surfaces the server message with the sail version hint", () => {
    const toast = mapStopOutcome(err(404, "not_found", "No route /v1/runs/run-b2/stop"), target);
    expect(toast.type).toBe("error");
    expect(toast.message).toContain("No route /v1/runs/run-b2/stop");
    expect(toast.message).toContain("v0.13.172");
  });

  test("other structured errors surface their own message and action", () => {
    const toast = mapStopOutcome(
      { ok: false, error: { status: 500, code: "internal", message: "boom", action: "retry" } },
      target,
    );
    expect(toast).toEqual({ type: "error", message: "boom — retry", refresh: false });
  });
});
