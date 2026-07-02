import { describe, expect, mock, test } from "bun:test";
import { SailApiError, SailConflictError, type ApiResult } from "./api/http";
import { createRequestHandlers, type HandlerDeps, type SailPort } from "./handlers";

const appInfo = { name: "Mast", version: "0.1.0", channel: "dev" };

function fakeSail(overrides: Partial<SailPort> = {}): SailPort {
  const ok = <T>(data: T): Promise<ApiResult<T>> => Promise.resolve({ data });
  const base = {
    listSpecs: () => ok({ specs: [], total: 0 }),
    board: () => ok({}),
    getSpec: () => ok({}),
    createSpec: () => ok({}),
    updateSpec: () => ok({}),
    deleteSpec: () => ok({}),
    getSpecContent: () => ok({}),
    putSpecContent: () => ok({}),
    specReviews: () => ok({}),
    specHistory: () => ok({}),
    restoreSpec: () => ok({}),
    getProject: () => ok({}),
    dispatch: () => ok({}),
    agentStatus: () => ok({}),
    agentLog: () => ok({}),
    agentSessions: () => ok({}),
    stopAgent: () => ok({}),
    agentReport: () => ok({}),
    getReview: () => ok({}),
    approveReview: () => ok({}),
    dismissFinding: () => ok({}),
    recentEvents: () => ok({}),
  } as unknown as SailPort;
  return { ...base, ...overrides };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    appInfo: () => appInfo,
    quit: () => {},
    onTheme: () => {},
    sail: fakeSail(),
    streamState: () => "connected",
    serverUrl: () => "http://localhost:7070",
    tokenPresent: () => true,
    ...overrides,
  };
}

describe("bun request handlers", () => {
  test("ping echoes the nonce", () => {
    const handlers = createRequestHandlers(makeDeps());
    expect(handlers.ping({ nonce: "n-1" })).toEqual({ pong: "pong", nonce: "n-1" });
  });

  test("getAppInfo returns injected app info", () => {
    const handlers = createRequestHandlers(makeDeps());
    expect(handlers.getAppInfo()).toEqual(appInfo);
  });

  test("quit invokes the injected quit fn", () => {
    const quit = mock(() => {});
    const handlers = createRequestHandlers(makeDeps({ quit }));
    handlers.quit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  test("setTheme forwards the reported theme", () => {
    const onTheme = mock(() => {});
    const handlers = createRequestHandlers(makeDeps({ onTheme }));
    handlers.setTheme({ theme: "light" });
    expect(onTheme).toHaveBeenCalledWith("light");
  });

  test("sail requests wrap success with the etag", async () => {
    const sail = fakeSail({
      getSpec: () =>
        Promise.resolve({
          data: { spec: { id: "s1" } },
          etag: '"2026-07-02T00:00:00Z"',
        }) as never,
    });
    const handlers = createRequestHandlers(makeDeps({ sail }));
    const result = await handlers.sailGetSpec({ id: "s1" });
    expect(result).toEqual({
      ok: true,
      value: { spec: { id: "s1" } } as never,
      etag: '"2026-07-02T00:00:00Z"',
    });
  });

  test("a 412 conflict crosses the boundary as a typed envelope", async () => {
    const sail = fakeSail({
      putSpecContent: () =>
        Promise.reject(new SailConflictError(412, "precondition_failed", "modified", "re-GET")),
    });
    const handlers = createRequestHandlers(makeDeps({ sail }));
    const result = await handlers.sailPutSpecContent({ id: "s1", content: { body: "x" } });
    expect(result).toEqual({
      ok: false,
      error: { status: 412, code: "precondition_failed", message: "modified", action: "re-GET" },
    });
  });

  test("network failures map to a status-0 envelope", async () => {
    const sail = fakeSail({ board: () => Promise.reject(new Error("ECONNREFUSED")) });
    const handlers = createRequestHandlers(makeDeps({ sail }));
    const result = await handlers.sailBoard({});
    expect(result).toEqual({
      ok: false,
      error: { status: 0, code: "network", message: "ECONNREFUSED" },
    });
  });

  test("api errors keep their code and status", async () => {
    const sail = fakeSail({
      dispatch: () => Promise.reject(new SailApiError(403, "forbidden", "ADMIN required")),
    });
    const handlers = createRequestHandlers(makeDeps({ sail }));
    const result = await handlers.sailDispatch({ project: "chorus", request: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });

  test("sailConnection reports stream state, server, and token presence", () => {
    const handlers = createRequestHandlers(makeDeps());
    expect(handlers.sailConnection()).toEqual({
      state: "connected",
      server: "http://localhost:7070",
      tokenPresent: true,
    });
  });
});
