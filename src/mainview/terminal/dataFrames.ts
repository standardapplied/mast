import { type SessionEnd, type SessionMeta, toSessionEnd, toSessionMeta } from "./connection";

/**
 * The session channel's framing. Everything a session says — output bytes, the replay markers,
 * state changes, and the ending — shares ONE ordered raw channel from the Rust core, so each
 * message is a tag byte followed by its payload. Only one channel can hold the order: a Tauri
 * event runs on its own lane and overtakes a large raw frame still in flight (a resize would then
 * re-parse the bytes emitted before it at the new geometry), and a mid-stream replay must reset
 * the terminal before the snapshot bytes land. Byte-pinned against `src-tauri/src/session_frames.rs`.
 */

export type DataFrame =
  | { readonly kind: "bytes"; readonly data: Uint8Array }
  | { readonly kind: "replay-begin"; readonly safe: boolean }
  | { readonly kind: "replay-end" }
  | { readonly kind: "meta"; readonly meta: SessionMeta }
  | { readonly kind: "exit"; readonly end: SessionEnd };

const TAG_BYTES = 0;
const TAG_REPLAY_BEGIN = 1;
const TAG_REPLAY_END = 2;
const TAG_META = 3;
const TAG_EXIT = 4;

export function decodeDataFrame(message: ArrayBuffer | Uint8Array): DataFrame {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (bytes.length === 0) {
    throw new Error("session data frame: empty message");
  }
  switch (bytes[0]) {
    case TAG_BYTES:
      return { kind: "bytes", data: bytes.subarray(1) };
    case TAG_REPLAY_BEGIN:
      if (bytes.length !== 2) {
        throw new Error(`session data frame: replay-begin carries ${bytes.length - 1} bytes, expected 1`);
      }
      return { kind: "replay-begin", safe: bytes[1] !== 0 };
    case TAG_REPLAY_END:
      if (bytes.length !== 1) {
        throw new Error(`session data frame: replay-end carries ${bytes.length - 1} bytes, expected 0`);
      }
      return { kind: "replay-end" };
    case TAG_META:
      return { kind: "meta", meta: toSessionMeta(json("meta", bytes)) };
    case TAG_EXIT:
      return { kind: "exit", end: toSessionEnd(json("exit", bytes)) };
    default:
      throw new Error(`session data frame: unknown tag ${bytes[0]}`);
  }
}

function json(name: string, frame: Uint8Array): unknown {
  const text = new TextDecoder().decode(frame.subarray(1));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`session data frame: ${name} payload is not JSON: ${text}`);
  }
}
