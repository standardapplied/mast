import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import { refusalDetail, snapshotEventOutcome, sortNewestFirst, sourceTone } from "./snapshots";

const event = (partial: Partial<SailEvent>): SailEvent => ({
  v: 1,
  ts: "2026-08-17T10:00:00Z",
  project: "acme",
  type: "snapshot_restored",
  agent: "sail",
  host: "box",
  ...partial,
});

describe("sourceTone", () => {
  test("maps each server source to a distinct badge tone", () => {
    expect(sourceTone("invite")).toBe("info");
    expect(sourceTone("guardrail")).toBe("warning");
    expect(sourceTone("dispatch")).toBe("neutral");
    expect(sourceTone("manual")).toBe("accent");
  });
});

describe("refusalDetail", () => {
  test("joins message and action verbatim", () => {
    expect(
      refusalDetail({
        status: 409,
        code: "agent_already_running",
        message: "Agent run r-7 is busy.",
        action: "Stop it first.",
      }),
    ).toBe("Agent run r-7 is busy. — Stop it first.");
  });

  test("stands alone when the server sent no action", () => {
    expect(refusalDetail({ status: 500, code: "internal", message: "Failed." })).toBe("Failed.");
  });
});

describe("sortNewestFirst", () => {
  test("orders by created_at descending without mutating the input", () => {
    const input = [
      { name: "old", created_at: "2026-08-01T00:00:00Z", source: "manual" },
      { name: "new", created_at: "2026-08-17T00:00:00Z", source: "invite" },
    ];
    expect(sortNewestFirst(input).map((s) => s.name)).toEqual(["new", "old"]);
    expect(input[0]!.name).toBe("old");
  });
});

describe("snapshotEventOutcome", () => {
  const pending = { name: "invite-run-3", action: "restore" as const };

  test("ignores other projects entirely", () => {
    expect(snapshotEventOutcome(event({ project: "zeta" }), "acme", pending)).toBeNull();
    expect(snapshotEventOutcome(event({ type: "spec_dispatched" }), "acme", pending)).toBeNull();
  });

  test("resolves the pending mutation on its matching event", () => {
    const outcome = snapshotEventOutcome(
      event({ data: { label: "invite-run-3" } }),
      "acme",
      pending,
    );
    expect(outcome).toEqual({ kind: "resolved", action: "restore", name: "invite-run-3" });
  });

  test("carries the server's error through a failed completion", () => {
    const outcome = snapshotEventOutcome(
      event({ data: { label: "invite-run-3", error: "boom" } }),
      "acme",
      pending,
    );
    expect(outcome).toEqual({
      kind: "resolved",
      action: "restore",
      name: "invite-run-3",
      error: "boom",
    });
  });

  test("a non-matching snapshot event only refreshes the list", () => {
    expect(
      snapshotEventOutcome(event({ data: { label: "other" } }), "acme", pending),
    ).toEqual({ kind: "refresh" });
    expect(
      snapshotEventOutcome(
        event({ type: "snapshot_deleted", data: { label: "invite-run-3" } }),
        "acme",
        pending,
      ),
    ).toEqual({ kind: "refresh" });
    expect(snapshotEventOutcome(event({ type: "snapshot_created" }), "acme", null)).toEqual({
      kind: "refresh",
    });
  });
});
