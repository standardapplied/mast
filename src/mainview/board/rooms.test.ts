import { describe, expect, test } from "bun:test";
import type {
  GlobalSpecView,
  SailEvent,
  ServerRoomView,
  SpecStatus,
} from "../../shared/sail-models";
import {
  assembleRooms,
  isPersonalRoom,
  isRoomActivityEvent,
  personalRoomId,
  readRoomWatermarks,
  relativeTime,
  sectionRooms,
  selectedRoom,
  roomIdFromTitle,
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
    room_id: id,
  };
}

function serverRoom(
  id: string,
  specIds: string[] = [id],
  createdAt = "2026-07-28T10:00:00Z",
): ServerRoomView {
  return {
    id,
    project: "mast",
    title: id,
    members: [],
    spec_ids: specIds,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/** The 1:1 fixture most tests want: each spec with its identity room, assembled. */
function identityRooms(
  entries: [string, SpecStatus?][],
  events: readonly SailEvent[] = [],
  watermarks: Record<string, string> = {},
) {
  return assembleRooms(
    entries.map(([id]) => serverRoom(id)),
    entries.map(([id, status]) => spec(id, status)),
    events,
    watermarks,
  );
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

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("room ordering and unread state", () => {
  test("orders by message or record activity with a stable id tie-break", () => {
    const rooms = identityRooms(
      [["alpha"], ["beta"], ["gamma"]],
      [
        event(1, "alpha", "spec_status_changed", "2026-07-28T13:00:00Z"),
        event(2, "beta", "spec_message_posted", "2026-07-28T12:00:00Z"),
        event(3, "gamma", "agent_tool_started", "2026-07-28T14:00:00Z"),
      ],
    );

    expect(rooms.map((room) => room.room.id)).toEqual(["alpha", "beta", "gamma"]);
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

    const rooms = identityRooms(
      [["s1"]],
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
    const rooms = assembleRooms(
      [serverRoom("s1", ["s1"], "2026-01-01T00:00:00Z")],
      [updated],
      [],
      { s1: "2026-07-28T00:00:00Z" },
    );

    expect(rooms[0]?.activityAt).toBe(updated.updated_at);
    expect(rooms[0]?.unread).toBe(true);
  });

  test("archive filtering hides terminal states but keeps all active states", () => {
    const rooms = identityRooms([
      ["draft", "draft"],
      ["pending"],
      ["working", "in_progress"],
      ["review", "review"],
      ["merge", "awaiting_merge"],
      ["done", "done"],
      ["cancelled", "cancelled"],
      ["archived", "archived"],
    ]);
    expect(visibleRooms(rooms, false).map((room) => room.room.id).sort()).toEqual([
      "draft",
      "merge",
      "pending",
      "review",
      "working",
    ]);
    expect(visibleRooms(rooms, true)).toHaveLength(8);
  });

  test("needsReply derives from the spec's server flag and defaults off", () => {
    const asking = { ...spec("s1"), needs_reply: true };
    expect(assembleRooms([serverRoom("s1")], [asking], [], {})[0]!.needsReply).toBe(true);
    expect(identityRooms([["s2"]])[0]!.needsReply).toBe(false);
  });

  test("visiting persists both the activity watermark and per-project selection", () => {
    const storage = memoryStorage();
    const room = identityRooms([["s1"]])[0]!;
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
    const room = identityRooms([["s1"]])[0]!;

    expect(visitRoom(storage, room)).toEqual({ s1: room.activityAt });
  });
});

describe("chat-only rooms", () => {
  test("a room with no attached spec leads the sidebar as a conversation", () => {
    const rooms = assembleRooms(
      [serverRoom("notes", []), serverRoom("s1")],
      [spec("s1")],
      [],
      {},
    );
    const sections = sectionRooms(rooms);

    expect(sections.map((section) => section.section)).toEqual(["chats", "ready", "archive"]);
    expect(sections[0]!.rooms.map((room) => room.room.id)).toEqual(["notes"]);
    expect(rooms.find((room) => room.room.id === "notes")?.spec).toBeUndefined();
  });

  test("chat rooms carry their own decoration and are never archived away", () => {
    const decorated = {
      ...serverRoom("notes", []),
      needs_reply: true,
      last_activity_at: "2026-07-29T09:00:00Z",
    };
    const rooms = assembleRooms([decorated], [], [], { notes: "2026-07-28T00:00:00Z" });

    expect(rooms[0]?.needsReply).toBe(true);
    expect(rooms[0]?.activityAt).toBe("2026-07-29T09:00:00Z");
    expect(rooms[0]?.unread).toBe(true);
    expect(visibleRooms(rooms, false)).toHaveLength(1);
  });

  test("a room attaches its spec through spec_ids, not id identity", () => {
    const rooms = assembleRooms([serverRoom("room-x", ["s1"])], [spec("s1")], [], {});

    expect(rooms[0]?.spec?.id).toBe("s1");
    expect(rooms[0]?.room.id).toBe("room-x");
  });
});

describe("new room ids", () => {
  test("derives a safe id and resolves collisions without another form field", () => {
    expect(roomIdFromTitle("  Café billing & tax  ", new Set())).toBe("cafe-billing-tax");
    expect(roomIdFromTitle("Billing", new Set(["billing", "billing-2"]))).toBe("billing-3");
  });

  test("rejects a title with no usable id", () => {
    expect(() => roomIdFromTitle("✨", new Set())).toThrow("letter or number");
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
    const rooms = assembleRooms(
      [serverRoom("s1", ["s1"], "2026-01-01T00:00:00Z")],
      [withServerActivity],
      [],
      {},
    );

    expect(rooms[0]?.activityAt).toBe("2026-07-29T09:00:00Z");
    expect(rooms[0]?.unread).toBe(true);
  });
});

describe("sidebar sections", () => {
  test("groups rooms into lifecycle sections preserving activity order", () => {
    const rooms = identityRooms([
      ["building", "in_progress"],
      ["reviewing", "review"],
      ["merging", "awaiting_merge"],
      ["queued", "pending"],
      ["sketch", "draft"],
      ["shipped", "done"],
      ["dropped", "cancelled"],
      ["mystery", "someday_new_status" as never],
    ]);

    const sections = sectionRooms(rooms);
    const byId = Object.fromEntries(
      sections.map((section) => [section.section, section.rooms.map((room) => room.room.id)]),
    );
    expect(byId["inflight"]).toEqual(["building", "merging", "mystery", "reviewing"]);
    expect(byId["ready"]).toEqual(["queued"]);
    expect(byId["drafts"]).toEqual(["sketch"]);
    expect(byId["archive"]).toEqual(["dropped", "shipped"]);
  });

  test("the reader's personal room pins first and only for its owner", () => {
    const rooms = assembleRooms(
      [serverRoom("fde-uday-mast", []), serverRoom("notes", []), serverRoom("s1")],
      [spec("s1")],
      [],
      {},
    );

    const mine = sectionRooms(rooms, "uday");
    expect(mine.map((section) => section.section)).toEqual([
      "personal",
      "chats",
      "ready",
      "archive",
    ]);
    expect(mine[0]!.rooms.map((room) => room.room.id)).toEqual(["fde-uday-mast"]);

    const theirs = sectionRooms(rooms, "rajesh");
    expect(theirs.map((section) => section.section)).toEqual(["chats", "ready", "archive"]);
    expect(theirs[0]!.rooms.map((room) => room.room.id)).toEqual(["fde-uday-mast", "notes"]);
    expect(sectionRooms(rooms).some((section) => section.section === "personal")).toBe(false);
  });

  test("the personal room id mirrors sail's minting rule", () => {
    expect(personalRoomId("rajesh", "acme")).toBe("fde-rajesh-acme");
    expect(personalRoomId("M.Day", "acme")).toBe("fde-m-day-acme");
    expect(isPersonalRoom(serverRoom("fde-uday-mast", []), "uday")).toBe(true);
    expect(isPersonalRoom(serverRoom("fde-uday-mast", []), undefined)).toBe(false);
  });

  test("empty sections are omitted except the archive anchor", () => {
    const sections = sectionRooms(identityRooms([["sketch", "draft"]]));
    expect(sections.map((section) => section.section)).toEqual(["drafts", "archive"]);
  });
});
