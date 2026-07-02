import { describe, expect, mock, test } from "bun:test";
import { createRequestHandlers } from "./handlers";

describe("bun request handlers", () => {
  const appInfo = { name: "Mast", version: "0.1.0", channel: "dev" };
  const deps = { appInfo: () => appInfo, quit: () => {}, onTheme: () => {} };

  test("ping echoes the nonce", () => {
    const handlers = createRequestHandlers(deps);
    expect(handlers.ping({ nonce: "n-1" })).toEqual({ pong: "pong", nonce: "n-1" });
  });

  test("getAppInfo returns injected app info", () => {
    const handlers = createRequestHandlers(deps);
    expect(handlers.getAppInfo()).toEqual(appInfo);
  });

  test("quit invokes the injected quit fn", () => {
    const quit = mock(() => {});
    const handlers = createRequestHandlers({ ...deps, quit });
    handlers.quit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  test("setTheme forwards the reported theme", () => {
    const onTheme = mock(() => {});
    const handlers = createRequestHandlers({ ...deps, onTheme });
    handlers.setTheme({ theme: "light" });
    expect(onTheme).toHaveBeenCalledWith("light");
  });
});
