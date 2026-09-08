import { describe, expect, test } from "bun:test";
import { exitFrame, metaFrame } from "../../../test/terminalFakes";
import { decodeDataFrame } from "./dataFrames";

// The exact bytes `session_frames.rs` produces; its tests pin the same values.
describe("decodeDataFrame", () => {
  test("tag 0 carries pty output bytes verbatim", () => {
    const frame = decodeDataFrame(new Uint8Array([0, 0x1b, 0x5b, 0x48, 0x00, 0xff]));
    expect(frame.kind).toBe("bytes");
    if (frame.kind !== "bytes") throw new Error("unreachable");
    expect(Array.from(frame.data)).toEqual([0x1b, 0x5b, 0x48, 0x00, 0xff]);
  });

  test("an empty output frame is valid and carries no bytes", () => {
    const frame = decodeDataFrame(new Uint8Array([0]));
    expect(frame).toMatchObject({ kind: "bytes" });
    if (frame.kind === "bytes") expect(frame.data.length).toBe(0);
  });

  test("tag 1 is replay-begin with its safe flag", () => {
    expect(decodeDataFrame(new Uint8Array([1, 1]))).toEqual({ kind: "replay-begin", safe: true });
    expect(decodeDataFrame(new Uint8Array([1, 0]))).toEqual({ kind: "replay-begin", safe: false });
  });

  test("tag 2 is replay-end", () => {
    expect(decodeDataFrame(new Uint8Array([2]))).toEqual({ kind: "replay-end" });
  });

  test("accepts the ArrayBuffer a Tauri raw channel delivers", () => {
    expect(decodeDataFrame(new Uint8Array([2]).buffer)).toEqual({ kind: "replay-end" });
  });

  test("tag 3 is a state change, read as the meta payload it carries", () => {
    expect(decodeDataFrame(metaFrame({ kind: "resized", cols: 132, rows: 40 }))).toEqual({
      kind: "meta",
      meta: { kind: "resized", cols: 132, rows: 40 },
    });
    expect(decodeDataFrame(metaFrame({ kind: "writer_changed", fde: "mady" }))).toEqual({
      kind: "meta",
      meta: { kind: "writer_changed", fde: "mady" },
    });
    expect(decodeDataFrame(metaFrame({ kind: "throttled" }))).toEqual({
      kind: "meta",
      meta: { kind: "unknown", raw: '{"kind":"throttled"}' },
    });
  });

  test("tag 4 is the ending, in the shape a failed open rejects with", () => {
    expect(decodeDataFrame(exitFrame({ class: "ended", reason: "exited(0)" }))).toEqual({
      kind: "exit",
      end: { klass: "ended", reason: "exited(0)" },
    });
    expect(decodeDataFrame(exitFrame({ class: "transport", reason: "connection reset" }))).toEqual({
      kind: "exit",
      end: { klass: "transport", reason: "connection reset" },
    });
  });

  test("rejects malformed frames loudly", () => {
    expect(() => decodeDataFrame(new Uint8Array([]))).toThrow("empty");
    expect(() => decodeDataFrame(new Uint8Array([1]))).toThrow("replay-begin");
    expect(() => decodeDataFrame(new Uint8Array([2, 9]))).toThrow("replay-end");
    expect(() => decodeDataFrame(new Uint8Array([3, 123]))).toThrow("meta payload is not JSON: {");
    expect(() => decodeDataFrame(new Uint8Array([4]))).toThrow("exit payload is not JSON");
    expect(() => decodeDataFrame(new Uint8Array([7]))).toThrow("unknown tag 7");
  });
});
