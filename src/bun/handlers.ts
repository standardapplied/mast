import type { ConnectionStatus } from "../shared/sail-models";
import type { AppInfo, AppRPCSchema, SailResult, ThemeName } from "../shared/types";
import type { SailClient } from "./api/client";
import { SailApiError, type ApiResult } from "./api/http";

const AUTH_ERROR_CODES = new Set(["missing_bearer_token", "invalid_bearer_token"]);

/**
 * The Bun main process's request handlers, expressed as pure functions over an
 * injected set of side-effecting dependencies. Keeping the FFI-bound bits
 * (quit, build metadata) and the network (SailClient) as injected deps lets us
 * unit-test the request logic with `bun test` without native bindings or a
 * live control plane.
 */
export type SailPort = Pick<
  SailClient,
  | "listSpecs"
  | "board"
  | "getSpec"
  | "createSpec"
  | "updateSpec"
  | "deleteSpec"
  | "getSpecContent"
  | "putSpecContent"
  | "specReviews"
  | "specHistory"
  | "restoreSpec"
  | "getProject"
  | "dispatch"
  | "agentStatus"
  | "agentLog"
  | "agentSessions"
  | "stopAgent"
  | "agentReport"
  | "getReview"
  | "approveReview"
  | "dismissFinding"
  | "recentEvents"
>;

export type HandlerDeps = {
  appInfo: () => AppInfo;
  quit: () => void;
  onTheme: (theme: ThemeName) => void;
  /** Getter — the connection manager rebuilds the client on tunnel/login. */
  sail: () => SailPort;
  connection: () => ConnectionStatus;
  login: () => Promise<{ ok: boolean; detail?: string }>;
  onAuthError: () => void;
};

type BunRequests = AppRPCSchema["bun"]["requests"];

export type BunRequestHandlers = {
  [M in keyof BunRequests]: (
    params: BunRequests[M]["params"],
  ) => BunRequests[M]["response"] | Promise<BunRequests[M]["response"]>;
};

/** Carry the typed error envelope across the RPC boundary instead of throwing. */
async function wrapWith<T>(
  call: () => Promise<ApiResult<T>>,
  onAuthError: () => void,
): Promise<SailResult<T>> {
  try {
    const { data, etag } = await call();
    return { ok: true, value: data, etag };
  } catch (error) {
    if (error instanceof SailApiError) {
      if (AUTH_ERROR_CODES.has(error.code)) onAuthError();
      return {
        ok: false,
        error: { status: error.status, code: error.code, message: error.message, action: error.action },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { status: 0, code: "network", message } };
  }
}

export function createRequestHandlers(deps: HandlerDeps): BunRequestHandlers {
  const sail = deps.sail;
  const wrap = <T>(call: () => Promise<ApiResult<T>>) => wrapWith(call, deps.onAuthError);
  return {
    ping: ({ nonce }) => ({ pong: "pong", nonce }),
    getAppInfo: () => deps.appInfo(),
    quit: () => {
      deps.quit();
    },
    setTheme: ({ theme }) => {
      deps.onTheme(theme);
    },

    sailListSpecs: (filter) => wrap(() => sail().listSpecs(filter ?? {})),
    sailBoard: ({ project }) => wrap(() => sail().board(project)),
    sailGetSpec: ({ id }) => wrap(() => sail().getSpec(id)),
    sailCreateSpec: (request) => wrap(() => sail().createSpec(request)),
    sailUpdateSpec: ({ id, request, ifMatch }) => wrap(() => sail().updateSpec(id, request, ifMatch)),
    sailDeleteSpec: ({ id, ifMatch }) => wrap(() => sail().deleteSpec(id, ifMatch)),
    sailGetSpecContent: ({ id }) => wrap(() => sail().getSpecContent(id)),
    sailPutSpecContent: ({ id, content, ifMatch }) =>
      wrap(() => sail().putSpecContent(id, content, ifMatch)),
    sailSpecReviews: ({ id }) => wrap(() => sail().specReviews(id)),
    sailSpecHistory: ({ id }) => wrap(() => sail().specHistory(id)),
    sailRestoreSpec: ({ id, rev }) => wrap(() => sail().restoreSpec(id, rev)),
    sailGetProject: ({ project }) => wrap(() => sail().getProject(project)),
    sailDispatch: ({ project, request }) => wrap(() => sail().dispatch(project, request)),
    sailAgentStatus: ({ project }) => wrap(() => sail().agentStatus(project)),
    sailAgentLog: ({ project, tail }) => wrap(() => sail().agentLog(project, tail)),
    sailAgentSessions: ({ project }) => wrap(() => sail().agentSessions(project)),
    sailStopAgent: ({ project }) => wrap(() => sail().stopAgent(project)),
    sailAgentReport: ({ project }) => wrap(() => sail().agentReport(project)),
    sailGetReview: ({ reviewId }) => wrap(() => sail().getReview(reviewId)),
    sailApproveReview: ({ reviewId }) => wrap(() => sail().approveReview(reviewId)),
    sailDismissFinding: ({ reviewId, findingId }) =>
      wrap(() => sail().dismissFinding(reviewId, findingId)),
    sailRecentEvents: ({ limit }) => wrap(() => sail().recentEvents(limit)),
    sailConnection: () => deps.connection(),
    sailLogin: () => deps.login(),
  };
}
