import { BrowserView } from "electrobun/bun";
import type { AppRPCSchema } from "../shared/types";
import { createRequestHandlers, type HandlerDeps } from "./handlers";

/**
 * Builds one Bun-side RPC instance for a BrowserView from the single
 * `AppRPCSchema`. One instance per view — the transport is not shareable.
 * `send.<message>(payload)` pushes typed messages to that view's webview.
 */
export function createMainRPC(deps: HandlerDeps) {
  return BrowserView.defineRPC<AppRPCSchema>({
    handlers: {
      requests: createRequestHandlers(deps),
      messages: {},
    },
  });
}

export type MainRPC = ReturnType<typeof createMainRPC>;
