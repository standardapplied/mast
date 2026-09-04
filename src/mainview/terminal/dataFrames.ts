/**
 * The session data channel's framing. Output bytes and the replay markers share ONE ordered raw
 * channel from the Rust core (a mid-stream replay must reset the terminal before the snapshot
 * bytes land, and only one channel can guarantee that order), so each message is a tag byte
 * followed by its payload. Byte-pinned against `src-tauri/src/session_frames.rs`.
 */

export type DataFrame =
  | { readonly kind: "bytes"; readonly data: Uint8Array }
  | { readonly kind: "replay-begin"; readonly safe: boolean }
  | { readonly kind: "replay-end" };

const TAG_BYTES = 0;
const TAG_REPLAY_BEGIN = 1;
const TAG_REPLAY_END = 2;

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
    default:
      throw new Error(`session data frame: unknown tag ${bytes[0]}`);
  }
}
