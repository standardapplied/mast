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
  relativeTime,
  sectionRooms,
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
    const rooms = assembleRooms(
      [spec("alpha"), spec("beta"), spec("gamma")],
      [
        event(1, "alpha", "spec_status_changed", "2026-07-28T13:00:00Z"),
        event(2, "beta", "spec_message_posted", "2026-07-28T12:00:00Z"),
        event(3, "gamma", "agent_tool_started", "2026-07-28T14:00:00Z"),
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
    expect(
      isRoomActivityEvent(event(3, "s1", "spec_message_posted", "2026-07-28T12:00:00Z")),
    ).toBe(true);

    const rooms = assembleRooms(
      [spec("s1")],
      [event(1, "s1", "agent_tool_started", "2026-07-28T12:00:00Z")],
      { s1: "2026-07-28T10:00:00Z" },
    );
    expect(rooms[0]?.unread).toBe(false);
  });

  test("uses the persisted spec update time when recent events are unavailable", () => {
    const updated = {
      ...spec("s1", "pending", "2026-01-01T00:00:00Z"),
      updated_at: "2026-07-29T00:00:00Z",
    };
    const rooms = assembleRooms([updated], [], { s1: "2026-07-28T00:00:00Z" });

    expect(rooms[0]?.activityAt).toBe(updated.updated_at);
    expect(rooms[0]?.unread).toBe(true);
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
    const room = assembleRooms([spec("s1")], [], {})[0]!;
    const watermarks = visitRoom(storage, room);

    expect(watermarks).toEqual({ s1: room.activityAt });
    expect(readRoomWatermarks(storage)).toEqual(watermarks);
    expect(selectedRoom(storage, "mast")).toBe("s1");
  });

  test("visiting remains usable when preference storage rejects writes", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    const room = assembleRooms([spec("s1")], [], {})[0]!;

    expect(visitRoom(storage, room)).toEqual({ s1: room.activityAt });
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

describe("relative time and server activity", () => {
  test("relativeTime steps from now to short dates", () => {
    const now = Date.parse("2026-07-29T12:00:00Z");
    expect(relativeTime("2026-07-29T11:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-07-29T11:20:00Z", now)).toBe("40m");
    expect(relativeTime("2026-07-29T03:00:00Z", now)).toBe("9h");
    expect(relativeTime("2026-07-27T12:00:00Z", now)).toBe("2d");
    expect(relativeTime("2026-07-01T00:00:00Z", now)).toMatch(/Jul/);
    expect(relativeTime("garbage", now)).toBe("");
  });

  test("server last_activity_at outranks the bounded event window", () => {
    const withServerActivity = {
      ...spec("s1", "pending", "2026-01-01T00:00:00Z"),
      updated_at: "2026-01-02T00:00:00Z",
      last_activity_at: "2026-07-29T09:00:00Z",
    };
    const rooms = assembleRooms([withServerActivity], [], {});

    expect(rooms[0]?.activityAt).toBe("2026-07-29T09:00:00Z");
    expect(rooms[0]?.unread).toBe(true);
  });
});

describe("sidebar sections", () => {
  test("groups rooms into lifecycle sections preserving activity order", () => {
    const rooms = assembleRooms(
      [
        spec("building", "in_progress"),
        spec("reviewing", "review"),
        spec("merging", "awaiting_merge"),
        spec("queued", "pending"),
        spec("sketch", "draft"),
        spec("shipped", "done"),
        spec("dropped", "cancelled"),
        spec("mystery", "someday_new_status" as never),
      ],
      [],
      {},
    );

    const sections = sectionRooms(rooms);
    const byId = Object.fromEntries(
      sections.map((section) => [section.section, section.rooms.map((room) => room.spec.id)]),
    );
    expect(byId["inflight"]).toEqual(["building", "merging", "mystery", "reviewing"]);
    expect(byId["ready"]).toEqual(["queued"]);
    expect(byId["drafts"]).toEqual(["sketch"]);
    expect(byId["archive"]).toEqual(["dropped", "shipped"]);
  });

  test("empty sections are omitted except the archive anchor", () => {
    const sections = sectionRooms(assembleRooms([spec("sketch", "draft")], [], {}));
    expect(sections.map((section) => section.section)).toEqual(["drafts", "archive"]);
  });
});
