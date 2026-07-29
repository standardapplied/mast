import { describe, expect, test } from "bun:test";
import type {
  GlobalSpecView,
  SailEvent,
  SpecMessage,
  SpecStatus,
} from "../../shared/sail-models";
import {
  assembleRooms,
  isRoomActivityEvent,
  readRoomWatermarks,
  selectedRoom,
  specIdFromTitle,
  visibleRooms,
  visitRoom,
  type StorageLike,
} from "./rooms";

function spec(
  id: string,
  status: SpecStatus = "pending",
  createdAt = "2026-07-28T10:00:00Z",
): GlobalSpecView {
  return {
    id,
    project: "mast",
    title: id,
    status,
    priority: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function event(id: number, specId: string, type: string, ts: string): SailEvent {
  return {
    v: 1,
    id,
    ts,
    project: "mast",
    spec: specId,
    type,
    agent: "codex",
    host: "dev",
  };
}

function message(specId: string, createdAt: string): SpecMessage {
  return {
    id: `message-${specId}`,
    spec_id: specId,
    author: "uday",
    body: "hello",
    created_at: createdAt,
  };
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("room ordering and unread state", () => {
  test("orders by message or record activity with a stable id tie-break", () => {
    const messages = new Map<string, SpecMessage[]>([
      ["beta", [message("beta", "2026-07-28T12:00:00Z")]],
    ]);
    const rooms = assembleRooms(
      [spec("alpha"), spec("beta"), spec("gamma")],
      messages,
      [
        event(1, "alpha", "spec_status_changed", "2026-07-28T13:00:00Z"),
        event(2, "gamma", "agent_tool_started", "2026-07-28T14:00:00Z"),
      ],
      {},
    );

    expect(rooms.map((room) => room.spec.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(rooms.map((room) => room.activityAt)).toEqual([
      "2026-07-28T13:00:00Z",
      "2026-07-28T12:00:00Z",
      "2026-07-28T10:00:00Z",
    ]);
  });

  test("telemetry is not record activity and cannot create phantom unreads", () => {
    expect(
      isRoomActivityEvent(event(1, "s1", "agent_tool_started", "2026-07-28T12:00:00Z")),
    ).toBe(false);
    expect(
      isRoomActivityEvent(event(2, "s1", "spec_status_changed", "2026-07-28T12:00:00Z")),
    ).toBe(true);

    const rooms = assembleRooms(
      [spec("s1")],
      new Map(),
      [event(1, "s1", "agent_tool_started", "2026-07-28T12:00:00Z")],
      { s1: "2026-07-28T10:00:00Z" },
    );
    expect(rooms[0]?.unread).toBe(false);
  });

  test("archive filtering hides terminal states but keeps all active states", () => {
    const rooms = assembleRooms(
      [
        spec("draft", "draft"),
        spec("pending"),
        spec("working", "in_progress"),
        spec("review", "review"),
        spec("merge", "awaiting_merge"),
        spec("done", "done"),
        spec("cancelled", "cancelled"),
        spec("archived", "archived"),
      ],
      new Map(),
      [],
      {},
    );
    expect(visibleRooms(rooms, false).map((room) => room.spec.id).sort()).toEqual([
      "draft",
      "merge",
      "pending",
      "review",
      "working",
    ]);
    expect(visibleRooms(rooms, true)).toHaveLength(8);
  });

  test("visiting persists both the activity watermark and per-project selection", () => {
    const storage = memoryStorage();
    const room = assembleRooms([spec("s1")], new Map(), [], {})[0]!;
    const watermarks = visitRoom(storage, room);

    expect(watermarks).toEqual({ s1: room.activityAt });
    expect(readRoomWatermarks(storage)).toEqual(watermarks);
    expect(selectedRoom(storage, "mast")).toBe("s1");
  });
});

describe("new room ids", () => {
  test("derives a safe id and resolves collisions without another form field", () => {
    expect(specIdFromTitle("  Café billing & tax  ", new Set())).toBe("cafe-billing-tax");
    expect(specIdFromTitle("Billing", new Set(["billing", "billing-2"]))).toBe("billing-3");
  });

  test("rejects a title with no usable id", () => {
    expect(() => specIdFromTitle("✨", new Set())).toThrow("letter or number");
  });
});
