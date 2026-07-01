import { describe, expect, mock, test } from "bun:test";
import { createRequestHandlers } from "./handlers";

describe("bun request handlers", () => {
  const appInfo = { name: "Mast", version: "0.1.0", channel: "dev" };

  test("ping echoes the nonce", () => {
    const handlers = createRequestHandlers({ appInfo: () => appInfo, quit: () => {} });
    expect(handlers.ping({ nonce: "n-1" })).toEqual({ pong: "pong", nonce: "n-1" });
  });

  test("getAppInfo returns injected app info", () => {
    const handlers = createRequestHandlers({ appInfo: () => appInfo, quit: () => {} });
    expect(handlers.getAppInfo()).toEqual(appInfo);
  });

  test("quit invokes the injected quit fn", () => {
    const quit = mock(() => {});
    const handlers = createRequestHandlers({ appInfo: () => appInfo, quit });
    handlers.quit();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
