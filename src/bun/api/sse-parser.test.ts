import { describe, expect, test } from "bun:test";
import { SSEParser } from "./sse-parser";

describe("SSEParser", () => {
  test("parses id/data frames and tracks the last event id", () => {
    const parser = new SSEParser();
    const { frames } = parser.feed('id: 41\ndata: {"type":"spec_status_changed"}\n\n');
    expect(frames).toEqual([{ id: "41", event: undefined, data: '{"type":"spec_status_changed"}' }]);
    expect(parser.lastEventId).toBe("41");
  });

  test("reassembles frames split across chunks", () => {
    const parser = new SSEParser();
    expect(parser.feed("id: 7\nda").frames).toEqual([]);
    const { frames } = parser.feed("ta: hello\n\n");
    expect(frames).toEqual([{ id: "7", event: undefined, data: "hello" }]);
  });

  test("joins multi-line data and reports heartbeats as activity", () => {
    const parser = new SSEParser();
    const heartbeat = parser.feed(":keepalive\n");
    expect(heartbeat.frames).toEqual([]);
    expect(heartbeat.sawActivity).toBe(true);

    const { frames } = parser.feed("data: a\ndata: b\n\n");
    expect(frames[0]?.data).toBe("a\nb");
  });

  test("multiple frames in one chunk", () => {
    const parser = new SSEParser();
    const { frames } = parser.feed("id: 1\ndata: x\n\nid: 2\ndata: y\n\n");
    expect(frames.map((f) => f.id)).toEqual(["1", "2"]);
  });
});
