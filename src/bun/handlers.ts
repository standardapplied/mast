import type { AppInfo, AppRPCSchema } from "../shared/types";

/**
 * The Bun main process's request handlers, expressed as pure functions over an
 * injected set of side-effecting dependencies. Keeping the FFI-bound bits
 * (quit, build metadata) as injected deps lets us unit-test the request logic
 * with `bun test` without loading Electrobun's native bindings.
 */
export type HandlerDeps = {
  appInfo: () => AppInfo;
  quit: () => void;
};

type BunRequests = AppRPCSchema["bun"]["requests"];

export type BunRequestHandlers = {
  [M in keyof BunRequests]: (
    params: BunRequests[M]["params"],
  ) => BunRequests[M]["response"] | Promise<BunRequests[M]["response"]>;
};

export function createRequestHandlers(deps: HandlerDeps): BunRequestHandlers {
  return {
    ping: ({ nonce }) => ({ pong: "pong", nonce }),
    getAppInfo: () => deps.appInfo(),
    quit: () => {
      deps.quit();
    },
  };
}
