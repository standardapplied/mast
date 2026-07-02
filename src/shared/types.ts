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

export type AppInfo = {
  name: string;
  version: string;
  channel: string;
};

export type BridgeStatus = "connected" | "reconnecting" | "disconnected";

export type ThemeName = "light" | "dark";

/** Payloads for Bun → webview push messages. Keys are the message names. */
export type AppPushMessages = {
  "bridge-status": { status: BridgeStatus };
  "update-status": { status: string; message: string };
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
