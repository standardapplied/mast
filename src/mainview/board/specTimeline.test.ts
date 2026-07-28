import { describe, expect, test } from "bun:test";
import type {
  ReviewDetailResponse,
  RunView,
  SailEvent,
  SpecMessage,
} from "../../shared/sail-models";
import {
  assembleTimeline,
  bufferTail,
  mergeMessages,
  releaseTail,
} from "./specTimeline";

const message = (id: string, createdAt: string): SpecMessage => ({
  id,
  spec_id: "s1",
  author: "uday",
  body: id,
  created_at: createdAt,
});

const event = (
  id: number,
  type: string,
  ts: string,
  data?: Record<string, unknown>,
): SailEvent => ({
  v: 1,
  id,
  ts,
  project: "mast",
  spec: "s1",
  type,
  agent: "codex/run-1",
  host: "devbox",
  data,
});

const review = (completedAt?: string): ReviewDetailResponse => ({
  review: {
    id: "r1",
    spec_id: "s1",
    iteration: 1,
    status: "running",
    created_at: "2026-07-28T10:01:00Z",
    ...(completedAt ? { completed_at: completedAt } : {}),
    stages: [],
  },
  findings: [],
});

test("interleaves messages, lifecycle events, and reviews chronologically", () => {
  const timeline = assembleTimeline({
    messages: [
      message("m1", "2026-07-28T10:00:00Z"),
      message("m2", "2026-07-28T10:03:00Z"),
    ],
    events: [event(1, "spec_dispatched", "2026-07-28T10:01:00Z")],
    reviews: [review("2026-07-28T10:02:00Z")],
    runs: [],
  });

  expect(timeline.map((item) => item.kind)).toEqual([
    "message",
    "lifecycle",
    "review",
    "message",
  ]);
});

test("the event registry renders rows and applies review overlays", () => {
  const timeline = assembleTimeline({
    messages: [],
    events: [
      event(1, "spec_status_changed", "2026-07-28T10:01:00Z"),
      event(2, "review_completed", "2026-07-28T10:02:00Z", { review_id: "r1" }),
      event(3, "review_approved", "2026-07-28T10:03:00Z", { review_id: "r1" }),
    ],
    reviews: [review()],
    runs: [],
  });

  expect(timeline.map((item) => item.kind)).toEqual(["review", "decision"]);
  expect(timeline[0]?.kind === "review" && timeline[0].review.completed_at).toBe(
    "2026-07-28T10:02:00Z",
  );
});

describe("message pagination", () => {
  test("merges overlapping page and live results without duplicates", () => {
    const merged = mergeMessages(
      [message("m2", "2026-07-28T10:02:00Z"), message("m3", "2026-07-28T10:03:00Z")],
      [message("m1", "2026-07-28T10:01:00Z"), message("m2", "2026-07-28T10:02:00Z")],
    );
    expect(merged.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("buffered tail", () => {
  test("withholds new arrivals while scrolled up and releases them atomically", () => {
    const held = bufferTail(
      { visible: [{ id: "1" }], buffered: [] },
      [{ id: "2" }, { id: "3" }],
      false,
    );
    expect(held).toEqual({
      visible: [{ id: "1" }],
      buffered: [{ id: "2" }, { id: "3" }],
    });
    expect(releaseTail(held)).toEqual({
      visible: [{ id: "1" }, { id: "2" }, { id: "3" }],
      buffered: [],
    });
  });

  test("appends immediately at the live edge and ignores duplicate arrivals", () => {
    const next = bufferTail(
      { visible: [{ id: "1" }], buffered: [] },
      [{ id: "1" }, { id: "2" }],
      true,
    );
    expect(next).toEqual({ visible: [{ id: "1" }, { id: "2" }], buffered: [] });
  });
});

test("attaches run links to lifecycle rows", () => {
  const run: RunView = {
    id: "run-1",
    project: "mast",
    spec_id: "s1",
    node: "devbox",
    role: "build",
    agent: "codex",
    status: "completed",
    started_at: "2026-07-28T10:00:00Z",
  };
  const timeline = assembleTimeline({
    messages: [],
    events: [event(1, "agent_stopped", "2026-07-28T10:01:00Z", { run_id: "run-1" })],
    reviews: [],
    runs: [run],
  });
  expect(timeline[0]?.kind === "lifecycle" && timeline[0].run).toEqual(run);
});
