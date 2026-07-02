import { describe, expect, test } from "bun:test";
import { createRPC } from "electrobun/view";
import { createRequestHandlers } from "../bun/handlers";
import type { AppRPCSchema } from "./types";

/**
 * End-to-end RPC round-trip over the real Electrobun RPC engine (createRPC),
 * with the two ends wired together by an in-memory transport pair. Exercises
 * both a request/response (webview → Bun → response) and a push message
 * (Bun → webview) through the actual wire protocol.
 */
function linkedTransports() {
  let bunHandler: (msg: unknown) => void = () => {};
  let webviewHandler: (msg: unknown) => void = () => {};
  return {
    bun: {
      send: (msg: unknown) => queueMicrotask(() => webviewHandler(msg)),
      registerHandler: (h: (msg: unknown) => void) => (bunHandler = h),
    },
    webview: {
      send: (msg: unknown) => queueMicrotask(() => bunHandler(msg)),
      registerHandler: (h: (msg: unknown) => void) => (webviewHandler = h),
    },
  };
}

describe("AppRPCSchema round-trip", () => {
  const handlers = createRequestHandlers({
    appInfo: () => ({ name: "Mast", version: "1.2.3", channel: "dev" }),
    quit: () => {},
    onTheme: () => {},
  });

  const transports = linkedTransports();

  // Bun side: handles bun.requests, sends webview.messages (push).
  const bun = createRPC({
    transport: transports.bun,
    requestHandler: (method: string | number, params: unknown) =>
      (handlers as Record<string, (p: unknown) => unknown>)[String(method)](params),
  });

  // Webview side: calls bun.requests, listens for push messages.
  const webview = createRPC({ transport: transports.webview });

  test("request/response: ping", async () => {
    const result = await webview.request("ping", { nonce: "abc" });
    expect(result).toEqual({ pong: "pong", nonce: "abc" });
  });

  test("request/response: getAppInfo", async () => {
    const info = await webview.request("getAppInfo");
    expect(info).toEqual({ name: "Mast", version: "1.2.3", channel: "dev" });
  });

  test("push message: Bun → webview", async () => {
    const received: Array<Record<string, unknown>> = [];
    webview.addMessageListener("update-status" as never, ((p: unknown) => {
      received.push(p as Record<string, unknown>);
    }) as never);

    const payload: AppRPCSchema["webview"]["messages"]["update-status"] = {
      status: "checking",
      message: "Checking for updates...",
    };
    bun.send("update-status" as never, payload as never);
    await new Promise((r) => queueMicrotask(() => r(null)));

    expect(received).toEqual([payload]);
  });
});
