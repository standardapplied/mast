/**
 * Types shared by every transport: the result envelope crossing the boundary,
 * the push payloads the UI listens for, and the app-wide constants.
 *
 * These stay free of any transport import so the same UI compiles against the
 * Tauri seam today and a WS/remote seam later. The Rust core is reached through
 * `src/mainview/tauri/`, which is the only place that knows about `invoke`.
 */

import type {
  ConnectionStatus,
  SailEvent,
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

export type ThemeName = "light" | "dark";

/** Payloads for push messages the webview receives. Keys are the message names. */
export type AppPushMessages = {
  "update-status": { status: string; message: string };
  /** A control-plane event from the SSE stream, deduplicated and gap-filled. */
  "sail-event": SailEvent;
  "connection-status": ConnectionStatus;
};

/** DOM CustomEvent names the webview dispatches for each push message. */
export type PushEventName = `rpc:${keyof AppPushMessages & string}`;
