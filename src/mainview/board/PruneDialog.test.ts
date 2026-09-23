import { describe, expect, test } from "bun:test";
import type { PruneReport } from "../../shared/sail-models";
import { pruneSummary } from "./PruneDialog";

function report(counts: Partial<PruneReport>): PruneReport {
  return {
    dry_run: true,
    requested: false,
    specs: 0,
    rooms: 0,
    messages: 0,
    runs: 0,
    reviews: 0,
    files: 0,
    projects: 0,
    events: 0,
    blob_bytes: 0,
    entries: [],
    ...counts,
  };
}

describe("pruneSummary", () => {
  test("names the one spec and says only what goes, never a zero", () => {
    expect(pruneSummary(report({ specs: 1, rooms: 1, events: 5, blob_bytes: 4096 }), "old")).toBe(
      "Erases old and its room from every box, history included — 4.0 KB freed. This can’t be undone.",
    );
  });

  test("lists everything that goes with it, one message and many runs alike", () => {
    expect(
      pruneSummary(report({ specs: 1, rooms: 1, messages: 1, runs: 3, reviews: 2 }), "old"),
    ).toBe(
      "Erases old, its room, 1 message, 3 runs and 2 reviews from every box, history included. This can’t be undone.",
    );
  });

  test("a spec born into a shared room goes alone", () => {
    expect(pruneSummary(report({ specs: 1 }), "child")).toBe(
      "Erases child from every box, history included. This can’t be undone.",
    );
  });

  test("several specs are counted, not named", () => {
    expect(pruneSummary(report({ specs: 3, rooms: 2, messages: 40 }))).toBe(
      "Erases 3 specs, 2 rooms and 40 messages from every box, history included. This can’t be undone.",
    );
  });
});
