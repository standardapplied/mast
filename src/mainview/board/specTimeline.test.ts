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
  eventNarration,
  groupTimeline,
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

  expect(timeline.map((item) => item.kind)).toEqual(["lifecycle", "review", "decision"]);
  expect(timeline[1]?.kind === "review" && timeline[1].review.completed_at).toBe(
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

describe("message grouping", () => {
  test("groups consecutive same-author messages inside five minutes", () => {
    const items = assembleTimeline({
      messages: [
        message("m1", "2026-07-28T10:00:00Z"),
        message("m2", "2026-07-28T10:05:00Z"),
        { ...message("m3", "2026-07-28T10:05:01Z"), author: "ravi" },
        message("m4", "2026-07-28T10:05:02Z"),
      ],
      events: [],
      reviews: [],
      runs: [],
    });

    const groups = groupTimeline(items);
    expect(groups.map((group) => group.kind)).toEqual([
      "message-group",
      "message-group",
      "message-group",
    ]);
    expect(groups[0]?.kind === "message-group" && groups[0].messages.map((item) => item.id))
      .toEqual(["message:m1", "message:m2"]);
  });

  test("breaks groups at lifecycle rows, the time window, and day dividers", () => {
    const items = assembleTimeline({
      messages: [
        message("m1", "2026-07-28T23:59:00"),
        message("m2", "2026-07-29T00:01:00"),
        message("m3", "2026-07-29T00:07:00"),
        message("m4", "2026-07-29T00:08:00"),
      ],
      events: [event(1, "spec_dispatched", "2026-07-29T00:07:30")],
      reviews: [],
      runs: [],
    });

    expect(groupTimeline(items).map((group) => group.kind)).toEqual([
      "message-group",
      "message-group",
      "message-group",
      "lifecycle",
      "message-group",
    ]);
  });

  test("keeps optimistic and failed deliveries inside their author's group", () => {
    const items = assembleTimeline({
      messages: [
        message("m1", "2026-07-28T10:00:00Z"),
        { ...message("pending:1", "2026-07-28T10:01:00Z"), delivery: "pending" },
        {
          ...message("pending:2", "2026-07-28T10:02:00Z"),
          delivery: "failed",
          error: "refused",
        },
      ],
      events: [],
      reviews: [],
      runs: [],
    });

    const [group] = groupTimeline(items);
    expect(group?.kind === "message-group" && group.messages.map((item) => item.message.delivery))
      .toEqual([undefined, "pending", "failed"]);
  });
});

describe("review-loop events", () => {
  test("every loop event renders as a labeled lifecycle row", () => {
    const expectations: Array<[string, string]> = [
      ["review_stage_started", "Review started"],
      ["review_stage_passed", "Review stage passed"],
      ["review_stage_failed", "Review stage failed"],
      ["review_iteration_started", "Fix iteration started"],
      ["guardrail_triggered", "Guardrail triggered"],
      ["agent_stop_nudged", "Agent nudged"],
      ["review_errored", "Review errored"],
      ["review_escalated", "Review escalated"],
      ["review_pipeline_error", "Review pipeline error"],
    ];
    const timeline = assembleTimeline({
      messages: [],
      events: expectations.map(([type], i) =>
        event(i + 1, type, `2026-07-28T10:0${Math.min(i, 9)}:00Z`)
      ),
      reviews: [],
      runs: [],
    });

    const rows = timeline.filter((item) => item.kind === "lifecycle");
    expect(rows.map((row) => (row.kind === "lifecycle" ? row.label : ""))).toEqual(
      expectations.map(([, label]) => label),
    );
  });

  test("review_failed is not a sail event and renders nothing", () => {
    const timeline = assembleTimeline({
      messages: [],
      events: [event(1, "review_failed", "2026-07-28T10:00:00Z")],
      reviews: [],
      runs: [],
    });
    expect(timeline).toEqual([]);
  });
});

describe("terminal whispers", () => {
  test("a pty session start is a lifecycle row narrating the executable", () => {
    const items = assembleTimeline({
      messages: [],
      events: [
        event(1, "pty_session_started", "2026-08-31T10:00:00Z", {
          session: "room-s1",
          room_id: "s1",
          executable: "claude",
        }),
      ],
      reviews: [],
      runs: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("lifecycle");
    expect((items[0] as { label: string }).label).toBe("Terminal opened");
    expect(eventNarration(items[0]!.kind === "lifecycle" ? items[0]!.event : ({} as SailEvent))).toBe(
      "claude",
    );
  });

  test("a yielded ending carries its reason; attach churn stays out of the timeline", () => {
    const items = assembleTimeline({
      messages: [],
      events: [
        event(2, "pty_session_attached", "2026-08-31T10:01:00Z", { session: "room-s1" }),
        event(3, "pty_session_ended", "2026-08-31T10:02:00Z", {
          session: "room-s1",
          reason: "yielded to dispatch r8 of spec s1",
        }),
      ],
      reviews: [],
      runs: [],
    });
    expect(items).toHaveLength(1);
    expect((items[0] as { label: string }).label).toBe("Terminal ended");
    expect(
      eventNarration(items[0]!.kind === "lifecycle" ? items[0]!.event : ({} as SailEvent)),
    ).toBe("yielded to dispatch r8 of spec s1");
  });
});

describe("eventNarration", () => {
  test("renders detail and severity counts in severity order", () => {
    const narration = eventNarration(
      event(1, "review_stage_failed", "2026-07-28T10:00:00Z", {
        detail: "codeandsecurity",
        findings: { low: 2, high: 2, medium: 1 },
      }),
    );
    expect(narration).toBe("codeandsecurity · 2 high, 1 medium, 2 low");
  });

  test("renders guardrail reason and action", () => {
    const narration = eventNarration(
      event(1, "guardrail_triggered", "2026-07-28T10:00:00Z", {
        reason: "fix agent left uncommitted changes in api (2 files: A.java, B.java)",
        action: "committed and pushed them to agent/spec",
      }),
    );
    expect(narration).toContain("A.java");
    expect(narration).toContain("committed and pushed");
  });

  test("renders nothing for an event without narration data", () => {
    expect(eventNarration(event(1, "agent_stopped", "2026-07-28T10:00:00Z"))).toBe("");
  });

  test("renders the snapshot label so rollback is one visible step", () => {
    const narration = eventNarration(
      event(1, "snapshot_created", "2026-08-16T10:00:00Z", {
        label: "invite-run-7",
        run_id: "run-7",
      }),
    );
    expect(narration).toBe("invite-run-7");
  });
});

test("a snapshot_created event renders as a lifecycle row in the timeline", () => {
  const timeline = assembleTimeline({
    messages: [],
    events: [event(1, "snapshot_created", "2026-08-16T10:00:00Z", { label: "invite-run-7" })],
    reviews: [],
    runs: [],
  });

  expect(timeline.map((item) => item.kind)).toEqual(["lifecycle"]);
  expect(timeline[0]?.kind === "lifecycle" && timeline[0].label).toBe("Snapshot");
});

test("a failed snapshot mutation is labeled as a failure, never as a success", () => {
  const timeline = assembleTimeline({
    messages: [],
    events: [
      event(1, "snapshot_restored", "2026-08-17T10:00:00Z", {
        label: "my-checkpoint",
        error: "incus restore failed: boom",
      }),
      event(2, "snapshot_deleted", "2026-08-17T10:01:00Z", {
        label: "invite-run-7",
        error: "storage error",
      }),
      event(3, "snapshot_restored", "2026-08-17T10:02:00Z", { label: "my-checkpoint" }),
    ],
    reviews: [],
    runs: [],
  });

  expect(
    timeline.map((item) => (item.kind === "lifecycle" ? item.label : "")),
  ).toEqual(["Snapshot restore failed", "Snapshot delete failed", "Snapshot restored"]);
});

test("a failed snapshot mutation's narration carries the error reason", () => {
  const narration = eventNarration(
    event(1, "snapshot_restored", "2026-08-17T10:00:00Z", {
      label: "my-checkpoint",
      error: "incus restore failed: boom",
    }),
  );
  expect(narration).toBe("my-checkpoint · incus restore failed: boom");
});

describe("engagement rows", () => {
  const base = { v: 1, ts: "2026-08-18T10:00:00Z", project: "acme", spec: "chat", host: "h" };

  test("joins and leaves render as rows; a clean chat-turn stop does not", () => {
    const items = assembleTimeline({
      messages: [],
      events: [
        { ...base, id: 1, type: "spec_engaged", agent: "sail", data: { agent: "claude-code", mode: "full" } },
        {
          ...base,
          id: 2,
          ts: "2026-08-18T10:05:00Z",
          type: "agent_session_stopped",
          agent: "claude-code",
          data: { run_role: "room-full", exit_code: 0 },
        },
        { ...base, id: 3, ts: "2026-08-18T10:06:00Z", type: "spec_disengaged", agent: "sail", data: { agent: "claude-code" } },
      ] as SailEvent[],
      reviews: [],
      runs: [],
    });
    const labels = items.filter((item) => item.kind === "lifecycle").map((item) => item.label);
    expect(labels).toEqual(["Agent joined the room", "Agent left the room"]);
  });

  test("a chat turn that died renders loud, and build stops are untouched", () => {
    const items = assembleTimeline({
      messages: [],
      events: [
        {
          ...base,
          id: 1,
          type: "agent_session_stopped",
          agent: "claude-code",
          data: { run_role: "room", exit_code: 137 },
        },
        {
          ...base,
          id: 2,
          ts: "2026-08-18T10:01:00Z",
          type: "agent_session_stopped",
          agent: "claude-code",
          data: { run_role: "build", exit_code: 0, source: "watcher" },
        },
      ] as SailEvent[],
      reviews: [],
      runs: [],
    });
    expect(items).toHaveLength(2);
  });

  test("an engage failure renders with its narration", () => {
    const items = assembleTimeline({
      messages: [],
      events: [
        {
          ...base,
          id: 1,
          type: "spec_engage_failed",
          agent: "sail",
          data: { agent: "codex", error: "no space left" },
        },
      ] as SailEvent[],
      reviews: [],
      runs: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("lifecycle");
    expect(eventNarration((items[0] as { event: SailEvent }).event)).toContain("no space left");
  });
});

