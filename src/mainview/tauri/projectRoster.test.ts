import { describe, expect, test } from "bun:test";
import type { ProjectListResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import {
  loadRoster,
  mergeRoster,
  rowHint,
  rowMeta,
  type ProjectRow,
  type RosterSources,
} from "./projectRoster";

const ok = (projects: ProjectListResponse["projects"]): SailResult<ProjectListResponse> => ({
  ok: true,
  value: { projects },
});

const sources = (
  catalog: () => Promise<SailResult<ProjectListResponse>>,
  targets: () => Promise<string[]>,
): RosterSources => ({ listProjects: catalog, listTargets: targets });

describe("mergeRoster", () => {
  test("unions catalog and routes, sorted by name", () => {
    const rows = mergeRoster(
      [
        { name: "zulu", container_status: "running" },
        { name: "alpha", container_status: "stopped" },
      ],
      ["mike"],
    );
    expect(rows.map((r) => r.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  test("running with a route is connectable", () => {
    const rows = mergeRoster([{ name: "a", container_status: "running" }], ["a"]);
    expect(rows).toEqual([{ name: "a", status: "running", connectable: true }]);
  });

  test("running without a route is not connectable", () => {
    const rows = mergeRoster([{ name: "a", container_status: "running" }], []);
    expect(rows).toEqual([{ name: "a", status: "running", connectable: false }]);
  });

  test.each(["stopped", "not_created", "error"] as const)(
    "%s is not connectable even with a route",
    (status) => {
      const rows = mergeRoster([{ name: "a", container_status: status }], ["a"]);
      expect(rows).toEqual([{ name: "a", status, connectable: false }]);
    },
  );

  test("route-only rows stay connectable with no status", () => {
    const rows = mergeRoster([], ["legacy"]);
    expect(rows).toEqual([{ name: "legacy", connectable: true }]);
  });

  test("empty sources yield an empty roster", () => {
    expect(mergeRoster([], [])).toEqual([]);
  });
});

describe("rowMeta", () => {
  const row = (partial: Partial<ProjectRow>): ProjectRow => ({
    name: "p",
    connectable: false,
    ...partial,
  });

  test("statuses render as labels", () => {
    expect(rowMeta(row({ status: "running", connectable: true }))).toBe("running");
    expect(rowMeta(row({ status: "stopped" }))).toBe("stopped");
    expect(rowMeta(row({ status: "not_created" }))).toBe("not created");
    expect(rowMeta(row({ status: "error" }))).toBe("error");
  });

  test("running without a route says so", () => {
    expect(rowMeta(row({ status: "running" }))).toBe("running · no ssh route");
  });

  test("route-only rows keep the historical label", () => {
    expect(rowMeta(row({ connectable: true }))).toBe("project container");
  });
});

describe("rowHint", () => {
  const row = (partial: Partial<ProjectRow>): ProjectRow => ({
    name: "p",
    connectable: false,
    ...partial,
  });

  test("connectable rows have no hint", () => {
    expect(rowHint(row({ status: "running", connectable: true }))).toBeUndefined();
  });

  test("each blocked state explains itself", () => {
    expect(rowHint(row({ status: "running" }))).toContain("sail connect p");
    expect(rowHint(row({ status: "stopped" }))).toContain("stopped");
    expect(rowHint(row({ status: "not_created" }))).toContain("no container");
    expect(rowHint(row({ status: "error" }))).toContain("error");
    expect(rowHint(row({})))?.toContain("No SSH route");
  });
});

describe("loadRoster", () => {
  test("merges both sources when both succeed", async () => {
    const roster = await loadRoster(
      sources(
        async () => ok([{ name: "chorus", container_status: "running" }]),
        async () => ["chorus", "legacy"],
      ),
    );
    expect(roster.error).toBeUndefined();
    expect(roster.warning).toBeUndefined();
    expect(roster.rows).toEqual([
      { name: "chorus", status: "running", connectable: true },
      { name: "legacy", connectable: true },
    ]);
  });

  test("catalog API error degrades to routes with a warning", async () => {
    const roster = await loadRoster(
      sources(
        async () => ({
          ok: false,
          error: { status: 503, code: "unavailable", message: "control plane down" },
        }),
        async () => ["chorus"],
      ),
    );
    expect(roster.rows).toEqual([{ name: "chorus", connectable: true }]);
    expect(roster.warning).toContain("control plane down");
    expect(roster.error).toBeUndefined();
  });

  test("catalog rejection degrades to routes with a warning", async () => {
    const roster = await loadRoster(
      sources(
        () => Promise.reject(new Error("bridge died")),
        async () => ["chorus"],
      ),
    );
    expect(roster.rows).toEqual([{ name: "chorus", connectable: true }]);
    expect(roster.warning).toContain("bridge died");
  });

  test("malformed catalog body degrades with a warning", async () => {
    const roster = await loadRoster(
      sources(
        async () => ({ ok: true, value: {} as ProjectListResponse }),
        async () => ["chorus"],
      ),
    );
    expect(roster.rows).toEqual([{ name: "chorus", connectable: true }]);
    expect(roster.warning).toContain("malformed");
  });

  test("routes failure keeps the catalog, nothing connectable", async () => {
    const roster = await loadRoster(
      sources(
        async () => ok([{ name: "chorus", container_status: "running" }]),
        () => Promise.reject(new Error("no ssh config")),
      ),
    );
    expect(roster.rows).toEqual([{ name: "chorus", status: "running", connectable: false }]);
    expect(roster.warning).toContain("no ssh config");
  });

  test("both sources failing is a roster error, not a rejection", async () => {
    const roster = await loadRoster(
      sources(
        () => Promise.reject(new Error("api down")),
        () => Promise.reject("fs denied"),
      ),
    );
    expect(roster.rows).toEqual([]);
    expect(roster.error).toBe("api down; fs denied");
    expect(roster.warning).toBeUndefined();
  });
});
