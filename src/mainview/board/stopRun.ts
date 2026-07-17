import type { RunView, StopRunResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";

/**
 * Pure outcome mapping for the clean-stop lane (POST /v1/runs/{id}/stop).
 * Stop is run-addressed like log-follow: the caller resolves the spec's
 * newest *running build* run and stops exactly that — never "latest run in
 * project", and never a blind stop when no running run is visible here.
 */

export type StopToast = {
  type: "success" | "info" | "error";
  message: string;
  /** Whether the spec/board should reload — the status may have changed. */
  refresh: boolean;
};

/** The newest running build run — the only thing Stop may target. */
export function runningBuildRun(runs: RunView[]): RunView | undefined {
  return runs
    .filter((run) => run.role === "build" && run.status === "running")
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
}

/** In-progress spec but no running run visible on this server — say so honestly. */
export function noRunningRunMessage(specId: string): string {
  return `No running build run for ${specId} on this server — it may be executing on another FDE's box. Nothing was stopped.`;
}

export function mapStopOutcome(result: SailResult<StopRunResponse>, run: RunView): StopToast {
  if (result.ok) {
    const { stopped, reason, spec_cancelled } = result.value;
    if (stopped) return { type: "success", message: "Stopped — spec cancelled.", refresh: true };
    switch (reason) {
      case "no_agent_running":
        return spec_cancelled
          ? {
              type: "success",
              message: "The agent was already gone — the spec was still rescued to cancelled.",
              refresh: true,
            }
          : { type: "info", message: "The agent is already gone — nothing to stop.", refresh: true };
      case "run_not_running":
        return {
          type: "info",
          message: `Run ${run.id} already finished — nothing to stop.`,
          refresh: true,
        };
      case "run_not_active":
        return {
          type: "info",
          message: "A newer attempt owns the agent — refreshing; retry the stop against it.",
          refresh: true,
        };
      default:
        return {
          type: "info",
          message: `Nothing was stopped${reason ? ` (${reason})` : ""}.`,
          refresh: true,
        };
    }
  }
  const error = result.error;
  if (error.code === "run_on_other_node") {
    return {
      type: "error",
      message: `Run ${run.id} executes on ${run.node || "another node"} — stop it from that box.`,
      refresh: false,
    };
  }
  if (error.code === "forbidden_not_assignee") {
    return { type: "error", message: `Only the assignee can stop run ${run.id}.`, refresh: false };
  }
  if (error.status === 404) {
    return {
      type: "error",
      message: `${error.message} — clean stop needs sail ≥ v0.13.172.`,
      refresh: false,
    };
  }
  return {
    type: "error",
    message: error.action ? `${error.message} — ${error.action}` : error.message,
    refresh: false,
  };
}
