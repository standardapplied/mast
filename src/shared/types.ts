/**
 * The single, transport-agnostic RPC contract between the Bun main process and
 * the React webview. Both sides derive their typed proxies from this one schema.
 *
 * Shape follows Electrobun's `ElectrobunRPCSchema` ({ bun, webview }):
 *  - `bun.requests`     — requests the Bun main handles (webview → Bun, awaited).
 *  - `webview.requests` — requests the webview handles (Bun → webview, awaited).
 *  - `bun.messages`     — fire-and-forget messages the Bun main receives.
 *  - `webview.messages` — fire-and-forget push messages the webview receives;
 *                         re-dispatched in the DOM as `rpc:<name>` CustomEvents.
 *
 * Keeping requests/responses and push messages in one declaration means a future
 * WS/remote transport is a drop-in: only the transport wiring changes, never the
 * app code that reads these types.
 */

import type {
  AgentReportResponse,
  ConnectionStatus,
  AgentStatusView,
  DispatchRequest,
  DispatchResponse,
  EventStreamState,
  FindingDismissResponse,
  GlobalBoardResponse,
  GlobalSpecContentResponse,
  GlobalSpecDetailResponse,
  GlobalSpecHistoryResponse,
  GlobalSpecsListResponse,
  ProjectResponse,
  RecentEventsResponse,
  ReviewApproveResponse,
  ReviewDetailResponse,
  ReviewListResponse,
  SailEvent,
  SessionListResponse,
  SpecContentRequest,
  SpecCreateRequest,
  SpecFilter,
  SpecUpdateRequest,
} from "./sail-models";

export type AppInfo = {
  name: string;
  version: string;
  channel: string;
};

export type SailWireError = {
  status: number;
  code: string;
  message: string;
  action?: string;
};

/**
 * API results crossing the RPC boundary keep their typed error envelope (a
 * thrown error would arrive at the webview as a bare message string). A 412
 * conflict is `{ ok: false, error: { code: "precondition_failed" } }`.
 */
export type SailResult<T> =
  | { ok: true; value: T; etag?: string }
  | { ok: false; error: SailWireError };

export type BridgeStatus = "connected" | "reconnecting" | "disconnected";

export type ThemeName = "light" | "dark";

/** Payloads for Bun → webview push messages. Keys are the message names. */
export type AppPushMessages = {
  "bridge-status": { status: BridgeStatus };
  "update-status": { status: string; message: string };
  /** A control-plane event from the SSE stream, deduplicated and gap-filled. */
  "sail-event": SailEvent;
  "connection-status": ConnectionStatus;
};

/** DOM CustomEvent names the webview dispatches for each push message. */
export type PushEventName = `rpc:${keyof AppPushMessages & string}`;

export type AppRPCSchema = {
  bun: {
    requests: {
      ping: { params: { nonce: string }; response: { pong: string; nonce: string } };
      getAppInfo: { params: void; response: AppInfo };
      quit: { params: void; response: void };
      /** Webview reports the active UI theme so terminals re-theme in lockstep. */
      setTheme: { params: { theme: ThemeName }; response: void };

      sailListSpecs: { params: SpecFilter; response: SailResult<GlobalSpecsListResponse> };
      sailBoard: { params: { project?: string }; response: SailResult<GlobalBoardResponse> };
      sailGetSpec: { params: { id: string }; response: SailResult<GlobalSpecDetailResponse> };
      sailCreateSpec: { params: SpecCreateRequest; response: SailResult<GlobalSpecDetailResponse> };
      sailUpdateSpec: {
        params: { id: string; request: SpecUpdateRequest; ifMatch?: string };
        response: SailResult<GlobalSpecDetailResponse>;
      };
      sailDeleteSpec: {
        params: { id: string; ifMatch?: string };
        response: SailResult<{ id: string; deleted: boolean }>;
      };
      sailGetSpecContent: { params: { id: string }; response: SailResult<GlobalSpecContentResponse> };
      sailPutSpecContent: {
        params: { id: string; content: SpecContentRequest; ifMatch?: string };
        response: SailResult<GlobalSpecContentResponse>;
      };
      sailSpecReviews: { params: { id: string }; response: SailResult<ReviewListResponse> };
      sailSpecHistory: { params: { id: string }; response: SailResult<GlobalSpecHistoryResponse> };
      sailRestoreSpec: {
        params: { id: string; rev: number };
        response: SailResult<GlobalSpecDetailResponse>;
      };
      sailGetProject: { params: { project: string }; response: SailResult<ProjectResponse> };
      sailDispatch: {
        params: { project: string; request: DispatchRequest };
        response: SailResult<DispatchResponse>;
      };
      sailAgentStatus: { params: { project: string }; response: SailResult<AgentStatusView> };
      sailAgentLog: {
        params: { project: string; tail: number };
        response: SailResult<{ log: string }>;
      };
      sailAgentSessions: { params: { project: string }; response: SailResult<SessionListResponse> };
      sailStopAgent: { params: { project: string }; response: SailResult<AgentStatusView> };
      sailAgentReport: { params: { project: string }; response: SailResult<AgentReportResponse> };
      sailGetReview: { params: { reviewId: string }; response: SailResult<ReviewDetailResponse> };
      sailApproveReview: {
        params: { reviewId: string };
        response: SailResult<ReviewApproveResponse>;
      };
      sailDismissFinding: {
        params: { reviewId: string; findingId: string };
        response: SailResult<FindingDismissResponse>;
      };
      sailRecentEvents: { params: { limit?: number }; response: SailResult<RecentEventsResponse> };
      sailConnection: { params: void; response: ConnectionStatus };
      /** Runs the browser passkey ceremony; resolves when signed in (or not). */
      sailLogin: { params: void; response: { ok: boolean; detail?: string } };
    };
    messages: Record<never, never>;
  };
  webview: {
    requests: {
      /** Bun asks the webview whether it is safe to quit (unsaved work gate). */
      confirmQuit: { params: void; response: { allow: boolean } };
    };
    messages: AppPushMessages;
  };
};

export const PING_TIMEOUT_MS = 1000;
export const BRIDGE_PING_INTERVAL_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
