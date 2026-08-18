import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import { coalesce, isTelemetryEvent, roomRefreshFor } from "./roomRouting";

const event = (type: string, data?: Record<string, unknown>): SailEvent => ({
  v: 1,
  id: 1,
  ts: "2026-08-18T10:00:00Z",
  project: "mast",
  spec: "s1",
  type,
  agent: "sail",
  host: "devbox",
  ...(data ? { data } : {}),
});

describe("roomRefreshFor", () => {
  test("telemetry and presence events fetch nothing", () => {
    for (const type of [
      "agent_tool_started",
      "agent_tool_finished",
      "agent_log_chunk",
      "agent_presence",
      "heartbeat",
    ]) {
      expect(isTelemetryEvent(type)).toBe(true);
      expect(roomRefreshFor(event(type))).toEqual({ kind: "none" });
    }
  });

  test("a message event names the message list", () => {
    expect(roomRefreshFor(event("spec_message_posted"))).toEqual({ kind: "messages" });
  });

  test("review events with the id refresh that detail; without it, the list", () => {
    expect(roomRefreshFor(event("review_stage_passed", { review_id: "rev-9" }))).toEqual({
      kind: "review-detail",
      reviewId: "rev-9",
    });
    expect(roomRefreshFor(event("finding_dismissed", { review: "rev-9" }))).toEqual({
      kind: "review-detail",
      reviewId: "rev-9",
    });
    expect(roomRefreshFor(event("review_stage_passed"))).toEqual({ kind: "reviews" });
  });

  test("list-shape boundaries refresh the review list", () => {
    expect(roomRefreshFor(event("review_iteration_started"))).toEqual({ kind: "reviews" });
    expect(roomRefreshFor(event("review_completed", { review_id: "rev-9" }))).toEqual({
      kind: "reviews",
    });
  });

  test("run-lifecycle events refresh runs only", () => {
    for (const type of ["spec_dispatched", "agent_session_completed", "agent_cancelled"]) {
      expect(roomRefreshFor(event(type))).toEqual({ kind: "runs" });
    }
  });

  test("self-narrating rows and unknown types split none from fallback", () => {
    expect(roomRefreshFor(event("spec_status_changed"))).toEqual({ kind: "none" });
    expect(roomRefreshFor(event("snapshot_restored"))).toEqual({ kind: "none" });
    expect(roomRefreshFor(event("some_future_event"))).toEqual({ kind: "fallback" });
  });
});

describe("coalesce", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a synchronous burst runs the fetch once", async () => {
    let runs = 0;
    const kick = coalesce(async () => {
      runs++;
    });
    kick();
    kick();
    kick();
    await flush();
    expect(runs).toBe(1);
  });

  test("kicks during a run mark it dirty and re-run exactly once", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const kick = coalesce(async () => {
      runs++;
      if (runs === 1) await gate;
    });
    kick();
    await Promise.resolve();
    expect(runs).toBe(1);
    kick();
    kick();
    release();
    await flush();
    expect(runs).toBe(2);
  });

  test("a failing fetch does not wedge the coalescer", async () => {
    let runs = 0;
    const kick = coalesce(async () => {
      runs++;
      throw new Error("boom");
    });
    kick();
    await flush();
    kick();
    await flush();
    expect(runs).toBe(2);
  });
});
