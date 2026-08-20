import { describe, expect, test } from "bun:test";
import {
  aggregateDeletes,
  duplicateDownloadName,
  humanBytes,
  transferPercent,
  upsertTransfer,
  type Transfer,
} from "./transfers";

const t = (over: Partial<Transfer>): Transfer => ({
  id: "1",
  kind: "upload",
  label: "x",
  filesDone: 0,
  filesTotal: 1,
  bytesDone: 0,
  bytesTotal: 0,
  status: "active",
  ...over,
});

describe("upsertTransfer", () => {
  test("appends a new id, preserving order", () => {
    const list = upsertTransfer([t({ id: "a" })], t({ id: "b" }));
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
  });
  test("replaces an existing id in place", () => {
    const list = upsertTransfer([t({ id: "a", bytesDone: 0 }), t({ id: "b" })], t({ id: "a", bytesDone: 99 }));
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
    expect(list[0]!.bytesDone).toBe(99);
  });
});

describe("aggregateDeletes", () => {
  test("is null when nothing is deleting", () => {
    expect(aggregateDeletes([t({ kind: "upload" })])).toBeNull();
  });
  test("collapses many deletes into one N-items row with a settled count", () => {
    const agg = aggregateDeletes([
      t({ id: "a", kind: "delete", status: "done" }),
      t({ id: "b", kind: "delete", status: "active" }),
      t({ id: "c", kind: "delete", status: "done" }),
    ]);
    expect(agg?.label).toBe("3 items");
    expect(agg?.filesTotal).toBe(3);
    expect(agg?.filesDone).toBe(2);
    expect(agg?.status).toBe("active");
  });
  test("a single delete keeps its own label", () => {
    const agg = aggregateDeletes([t({ kind: "delete", label: "notes.md", status: "active" })]);
    expect(agg?.label).toBe("notes.md");
    expect(agg?.filesTotal).toBe(1);
  });
  test("settles to done when all succeed, error (with count) when any fail", () => {
    expect(
      aggregateDeletes([
        t({ id: "a", kind: "delete", status: "done" }),
        t({ id: "b", kind: "delete", status: "done" }),
      ])?.status,
    ).toBe("done");
    const failed = aggregateDeletes([
      t({ id: "a", kind: "delete", status: "done" }),
      t({ id: "b", kind: "delete", status: "error" }),
    ]);
    expect(failed?.status).toBe("error");
    expect(failed?.detail).toBe("1 failed");
  });
});

describe("transferPercent", () => {
  test("by bytes when known", () => {
    expect(transferPercent(t({ bytesDone: 50, bytesTotal: 200 }))).toBe(0.25);
  });
  test("by file count when no byte total", () => {
    expect(transferPercent(t({ filesDone: 3, filesTotal: 4, bytesTotal: 0 }))).toBe(0.75);
  });
  test("done is always 1; clamps over-count", () => {
    expect(transferPercent(t({ status: "done", bytesDone: 0, bytesTotal: 10 }))).toBe(1);
    expect(transferPercent(t({ bytesDone: 30, bytesTotal: 10 }))).toBe(1);
  });
});

describe("duplicateDownloadName", () => {
  test("distinct names pass", () => {
    expect(duplicateDownloadName(["a.txt", "b.txt"])).toBeNull();
    expect(duplicateDownloadName([])).toBeNull();
  });
  test("same basename from different directories collides", () => {
    expect(duplicateDownloadName(["config.json", "config.json"])).toBe("config.json");
  });
  test("case-insensitive — the default macOS filesystem is", () => {
    expect(duplicateDownloadName(["README.md", "readme.md"])).toBe("readme.md");
  });
});

describe("humanBytes", () => {
  test("scales units", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(humanBytes(1610612736)).toBe("1.5 GB");
  });
});
