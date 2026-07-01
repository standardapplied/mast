import { Electroview } from "electrobun/view";
import type { AppRPCSchema } from "../shared/types";
import { dispatchPush } from "./push";
import { shouldAllowQuit } from "./quit-gate";
import { BridgeWatchdog } from "./watchdog";

/**
 * Wires the webview end of the typed RPC:
 *  - handles `confirmQuit` (Bun → webview) via the React quit gate,
 *  - re-dispatches every Bun → webview push message as an `rpc:*` DOM event,
 *  - starts the bridge watchdog so the localhost socket recovers after sleep.
 *
 * One `Electroview`/RPC instance per view — the transport is not shareable.
 */
export type Bridge = ReturnType<typeof createBridge>;

export function createBridge() {
  const rpc = Electroview.defineRPC<AppRPCSchema>({
    handlers: {
      requests: {
        confirmQuit: async () => ({ allow: await shouldAllowQuit() }),
      },
      messages: {
        "*": (name, payload) => {
          dispatchPush(name as keyof AppRPCSchema["webview"]["messages"] & string, payload as never);
        },
      },
    },
  });

  const electroview = new Electroview<typeof rpc>({ rpc });
  const api = rpc.request;

  const watchdog = new BridgeWatchdog({
    bridge: electroview,
    ping: () => api.ping({ nonce: crypto.randomUUID() }),
  });
  watchdog.start();

  return { electroview, rpc, api, watchdog };
}
