import type {
  GlobalSpecView,
  SailEvent,
  ServerRoomView,
  SpecStatus,
} from "../../shared/sail-models";

export const ROOM_WATERMARKS_KEY = "mast.rooms.watermarks";
export const ROOM_SELECTIONS_KEY = "mast.rooms.selections";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type RoomView = {
  room: ServerRoomView;
  /** The room's attached spec, when one exists — chat-only rooms carry none. */
  spec?: GlobalSpecView;
  activityAt: string;
  unread: boolean;
  /** The room's agent asked a question no human has answered yet. */
  needsReply: boolean;
};

const ARCHIVE_STATUSES = new Set<SpecStatus>(["done", "cancelled", "archived"]);
const NON_RECORD_EVENT_TYPES = new Set([
  "agent_tool_started",
  "agent_tool_finished",
  "agent_log_chunk",
  "agent_presence",
  "heartbeat",
]);

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function storedMap(storage: StorageLike, key: string): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function isRoomActivityEvent(event: SailEvent): boolean {
  return Boolean(event.spec && !NON_RECORD_EVENT_TYPES.has(event.type));
}

/** Folds record events into a room-id → newest-activity-timestamp map, in place. */
export function foldActivity(
  map: Map<string, string>,
  events: readonly SailEvent[],
): Map<string, string> {
  for (const event of events) {
    if (!isRoomActivityEvent(event)) continue;
    const current = map.get(event.spec!);
    if (!current || timestamp(event.ts) > timestamp(current)) {
      map.set(event.spec!, event.ts);
    }
  }
  return map;
}

export function assembleRooms(
  serverRooms: readonly ServerRoomView[],
  specs: readonly GlobalSpecView[],
  activity: readonly SailEvent[] | ReadonlyMap<string, string>,
  watermarks: Readonly<Record<string, string>>,
): RoomView[] {
  const eventActivity =
    activity instanceof Map ? activity : foldActivity(new Map(), activity as SailEvent[]);
  const specsById = new Map(specs.map((spec) => [spec.id, spec]));

  return serverRooms
    .map((room) => {
      const spec = room.spec_ids
        .map((id) => specsById.get(id))
        .find((candidate): candidate is GlobalSpecView => Boolean(candidate));
      const candidates = [
        room.created_at,
        room.updated_at,
        room.last_activity_at,
        spec?.updated_at,
        spec?.last_activity_at,
        eventActivity.get(room.id),
      ].filter((value): value is string => Boolean(value));
      const activityAt = candidates.sort(
        (left, right) => timestamp(right) - timestamp(left) || right.localeCompare(left),
      )[0] ?? room.created_at;
      const watermark = watermarks[room.id];
      return {
        room,
        spec,
        activityAt,
        unread: !watermark || timestamp(activityAt) > timestamp(watermark),
        needsReply: room.needs_reply === true || spec?.needs_reply === true,
      };
    })
    .sort(
      (left, right) =>
        timestamp(right.activityAt) - timestamp(left.activityAt) ||
        left.room.id.localeCompare(right.room.id),
    );
}

export type RoomSection = "personal" | "chats" | "inflight" | "ready" | "drafts" | "archive";

export const SECTION_LABELS: Record<RoomSection, string> = {
  personal: "Personal",
  chats: "Conversations",
  inflight: "In flight",
  ready: "Ready",
  drafts: "Drafts",
  archive: "Archive",
};

/** Section marks speak the badge's tone vocabulary — same squares, same tokens. */
export const SECTION_TONES: Record<RoomSection, string> = {
  personal: "accent",
  chats: "info",
  inflight: "accent",
  ready: "info",
  drafts: "neutral",
  archive: "success",
};

const SECTION_ORDER: RoomSection[] = ["personal", "chats", "inflight", "ready", "drafts", "archive"];

/** Unknown statuses from a newer sail are treated as active work, never silently hidden. */
export function sectionOf(status: SpecStatus | string): RoomSection {
  if (ARCHIVE_STATUSES.has(status as SpecStatus)) return "archive";
  if (status === "draft") return "drafts";
  if (status === "pending") return "ready";
  return "inflight";
}

/** Whether `room` is the personal room of the signed-in FDE (`me`), as sail marks it. */
export function isPersonalRoom(room: ServerRoomView, me: string | undefined): boolean {
  return me !== undefined && room.personal_of === me;
}

/** The reader's personal room pins first; a chat-only room has no lifecycle and lives in the conversations section. */
export function sectionOfRoom(room: RoomView, me?: string): RoomSection {
  if (isPersonalRoom(room.room, me)) return "personal";
  return room.spec ? sectionOf(room.spec.status) : "chats";
}

export type SectionedRooms = { section: RoomSection; rooms: RoomView[] };

/**
 * Rooms grouped for the sidebar: the reader's personal room first, then lifecycle
 * sections in fixed order, activity order preserved within each. Empty sections
 * vanish — except the archive, which always anchors the bottom as the collapsible
 * history of the project.
 */
export function sectionRooms(rooms: readonly RoomView[], me?: string): SectionedRooms[] {
  const buckets = new Map<RoomSection, RoomView[]>(
    SECTION_ORDER.map((section) => [section, []]),
  );
  for (const room of rooms) {
    buckets.get(sectionOfRoom(room, me))!.push(room);
  }
  return SECTION_ORDER.flatMap((section) => {
    const bucket = buckets.get(section)!;
    return bucket.length > 0 || section === "archive" ? [{ section, rooms: bucket }] : [];
  });
}

export function visibleRooms(rooms: readonly RoomView[], showArchive: boolean): RoomView[] {
  return rooms.filter(
    (room) => showArchive || !room.spec || !ARCHIVE_STATUSES.has(room.spec.status),
  );
}

export function isArchivedRoom(status: SpecStatus): boolean {
  return ARCHIVE_STATUSES.has(status);
}

export function readRoomWatermarks(storage: StorageLike): Record<string, string> {
  return storedMap(storage, ROOM_WATERMARKS_KEY);
}

export function visitRoom(storage: StorageLike, room: RoomView): Record<string, string> {
  const next = { ...readRoomWatermarks(storage), [room.room.id]: room.activityAt };
  try {
    storage.setItem(ROOM_WATERMARKS_KEY, JSON.stringify(next));
  } catch {}
  const selections = storedMap(storage, ROOM_SELECTIONS_KEY);
  try {
    storage.setItem(
      ROOM_SELECTIONS_KEY,
      JSON.stringify({ ...selections, [room.room.project]: room.room.id }),
    );
  } catch {}
  return next;
}

export function selectedRoom(storage: StorageLike, project: string): string | undefined {
  return storedMap(storage, ROOM_SELECTIONS_KEY)[project];
}

const RELATIVE_STEPS: [number, (elapsed: number) => string][] = [
  [60_000, () => "now"],
  [3_600_000, (elapsed) => `${Math.floor(elapsed / 60_000)}m`],
  [86_400_000, (elapsed) => `${Math.floor(elapsed / 3_600_000)}h`],
  [604_800_000, (elapsed) => `${Math.floor(elapsed / 86_400_000)}d`],
];

/** Compact relative time for sidebar rows; falls back to a short date past a week. */
export function relativeTime(value: string, now: number): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  const elapsed = Math.max(0, now - parsed);
  for (const [limit, render] of RELATIVE_STEPS) {
    if (elapsed < limit) return render(elapsed);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parsed);
}

export function roomIdFromTitle(title: string, existingIds: ReadonlySet<string>): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/g, "");
  if (!base) throw new Error("Title must contain a letter or number.");
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}
