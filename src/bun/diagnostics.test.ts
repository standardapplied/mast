import { beforeEach, describe, expect, test } from "bun:test";
import { clearLogs, diag, diagnosticsReport, log, recentLogs } from "./diagnostics";

beforeEach(() => clearLogs());

describe("diagnostics logger", () => {
  test("buffers entries with level, scope, and message", () => {
    diag.info("probe", "health ok", { status: 200 });
    diag.warn("http", "slow", { ms: 900 });
    const entries = recentLogs();
    expect(entries.map((e) => e.scope)).toEqual(["probe", "http"]);
    expect(entries[0]?.level).toBe("info");
    expect(entries[1]?.data).toEqual({ ms: 900 });
  });

  test("redacts secret keys and token-shaped values but not descriptive fields", () => {
    diag.info("connect", "using token sail_abcdef1234567890", {
      token: "sess_deadbeef",
      tokenKind: "api",
      server: "http://x",
    });
    const entry = recentLogs()[0]!;
    expect(entry.data?.token).toBe("<13 chars>");
    expect(entry.data?.tokenKind).toBe("api");
    expect(entry.data?.server).toBe("http://x");
    expect(entry.message).toContain("sail_<redacted>");
    expect(entry.message).not.toContain("abcdef1234567890");
  });

  test("the report carries the header facts and the log tail", () => {
    diag.info("boot", "starting");
    diag.error("http", "GET /v1/specs timed out", { ms: 15000 });
    const report = diagnosticsReport({ version: "0.1.0", phase: "ready", token: "sess_secret" });
    expect(report).toContain("=== Mast diagnostics ===");
    expect(report).toContain("version: 0.1.0");
    expect(report).toContain("token: <11 chars>");
    expect(report).toContain("[http] GET /v1/specs timed out");
  });

  test("caps the ring buffer", () => {
    for (let i = 0; i < 1000; i++) log("info", "loop", `entry ${i}`);
    const entries = recentLogs();
    expect(entries.length).toBeLessThanOrEqual(800);
    expect(entries.at(-1)?.message).toBe("entry 999");
  });
});
