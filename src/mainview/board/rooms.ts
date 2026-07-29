import type { GlobalSpecView, SailEvent, SpecStatus } from "../../shared/sail-models";

export const ROOM_WATERMARKS_KEY = "mast.rooms.watermarks";
export const ROOM_SELECTIONS_KEY = "mast.rooms.selections";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type RoomView = {
  spec: GlobalSpecView;
  activityAt: string;
  unread: boolean;
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

export function assembleRooms(
  specs: GlobalSpecView[],
  events: readonly SailEvent[],
  watermarks: Readonly<Record<string, string>>,
): RoomView[] {
  const eventActivity = new Map<string, string>();
  for (const event of events) {
    if (!isRoomActivityEvent(event)) continue;
    const current = eventActivity.get(event.spec!);
    if (!current || timestamp(event.ts) > timestamp(current)) {
      eventActivity.set(event.spec!, event.ts);
    }
  }

  return specs
    .map((spec) => {
      const candidates = [
        spec.created_at,
        spec.updated_at,
        spec.last_activity_at,
        eventActivity.get(spec.id),
      ].filter((value): value is string => Boolean(value));
      const activityAt = candidates.sort(
        (left, right) => timestamp(right) - timestamp(left) || right.localeCompare(left),
      )[0] ?? spec.created_at;
      const watermark = watermarks[spec.id];
      return {
        spec,
        activityAt,
        unread: !watermark || timestamp(activityAt) > timestamp(watermark),
      };
    })
    .sort(
      (left, right) =>
        timestamp(right.activityAt) - timestamp(left.activityAt) ||
        left.spec.id.localeCompare(right.spec.id),
    );
}

export function visibleRooms(rooms: readonly RoomView[], showArchive: boolean): RoomView[] {
  return rooms.filter((room) => showArchive || !ARCHIVE_STATUSES.has(room.spec.status));
}

export function isArchivedRoom(status: SpecStatus): boolean {
  return ARCHIVE_STATUSES.has(status);
}

export function readRoomWatermarks(storage: StorageLike): Record<string, string> {
  return storedMap(storage, ROOM_WATERMARKS_KEY);
}

export function visitRoom(storage: StorageLike, room: RoomView): Record<string, string> {
  const next = { ...readRoomWatermarks(storage), [room.spec.id]: room.activityAt };
  try {
    storage.setItem(ROOM_WATERMARKS_KEY, JSON.stringify(next));
  } catch {}
  const selections = storedMap(storage, ROOM_SELECTIONS_KEY);
  try {
    storage.setItem(
      ROOM_SELECTIONS_KEY,
      JSON.stringify({ ...selections, [room.spec.project]: room.spec.id }),
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

export function specIdFromTitle(title: string, existingIds: ReadonlySet<string>): string {
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
