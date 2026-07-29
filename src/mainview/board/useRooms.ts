import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlobalSpecView, SailEvent } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import type { Gateway } from "../gateway";
import {
  assembleRooms,
  isRoomActivityEvent,
  readRoomWatermarks,
  specIdFromTitle,
  visitRoom,
  type RoomView,
  type StorageLike,
} from "./rooms";

type RoomsData = {
  rooms: RoomView[];
  projects: string[];
  loading: boolean;
  error: SailWireError | null;
};

const EMPTY_DATA: RoomsData = {
  rooms: [],
  projects: [],
  loading: true,
  error: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeEvents(events: readonly SailEvent[]): SailEvent[] {
  const byId = new Map<string, SailEvent>();
  for (const event of events) {
    const key = event.id === undefined
      ? `${event.type}:${event.ts}:${event.spec ?? ""}:${event.agent}`
      : String(event.id);
    byId.set(key, event);
  }
  return [...byId.values()];
}

async function projectNames(gateway: Gateway): Promise<string[]> {
  try {
    const result = await gateway.listProjects();
    return result.ok && Array.isArray(result.value.projects)
      ? result.value.projects.map((project) => project.name)
      : [];
  } catch {
    return [];
  }
}

export function useRooms(
  gateway: Gateway,
  storage: StorageLike = localStorage,
) {
  const [data, setData] = useState<RoomsData>(EMPTY_DATA);
  const [watermarks, setWatermarks] = useState(() => readRoomWatermarks(storage));
  const watermarksRef = useRef(watermarks);
  watermarksRef.current = watermarks;
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const recentPromise = gateway.recentEvents(500).catch(() => null);
    const catalogPromise = projectNames(gateway);
    let specsResult;
    try {
      specsResult = await gateway.listSpecs({});
    } catch (error) {
      if (current !== generation.current) return;
      setData((previous) => ({
        ...previous,
        loading: false,
        error: { status: 0, code: "bridge", message: errorMessage(error) },
      }));
      return;
    }
    if (current !== generation.current) return;
    if (!specsResult.ok) {
      setData((previous) => ({ ...previous, loading: false, error: specsResult.error }));
      return;
    }

    const specs = specsResult.value.specs;
    setData({
      rooms: assembleRooms(specs, [], watermarksRef.current),
      projects: [...new Set(specs.map((spec: GlobalSpecView) => spec.project))].sort(),
      loading: false,
      error: null,
    });

    const [recentResult, catalog] = await Promise.all([recentPromise, catalogPromise]);
    if (current !== generation.current) return;
    const projects = [
      ...new Set([...catalog, ...specs.map((spec: GlobalSpecView) => spec.project)]),
    ].sort();
    setData({
      rooms: assembleRooms(
        specs,
        recentResult?.ok ? mergeEvents(recentResult.value.events) : [],
        watermarksRef.current,
      ),
      projects,
      loading: false,
      error: null,
    });
  }, [gateway]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let queued = false;
    return gateway.onEvent((event) => {
      if (
        event.type !== "board_updated" &&
        event.type !== "spec_message_posted" &&
        !isRoomActivityEvent(event)
      ) return;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void refresh();
      });
    });
  }, [gateway, refresh]);

  const open = useCallback((room: RoomView) => {
    setWatermarks(visitRoom(storage, room));
  }, [storage]);

  const create = useCallback(async (title: string, project: string) => {
    const trimmed = title.trim();
    if (!trimmed) {
      return {
        ok: false as const,
        error: { status: 0, code: "invalid_title", message: "Enter a room title." },
      };
    }
    if (!project) {
      return {
        ok: false as const,
        error: { status: 0, code: "invalid_project", message: "Choose a project." },
      };
    }
    const existingIds = new Set(data.rooms.map((room) => room.spec.id));
    let id: string;
    try {
      id = specIdFromTitle(trimmed, existingIds);
    } catch (error) {
      return {
        ok: false as const,
        error: { status: 0, code: "invalid_title", message: errorMessage(error) },
      };
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await gateway.createSpec({
        id,
        project,
        title: trimmed,
        status: "draft",
        body: "",
      });
      if (result.ok) {
        await refresh();
        return result;
      }
      if (result.error.status !== 409 || result.error.code !== "spec_exists") return result;
      existingIds.add(id);
      id = specIdFromTitle(trimmed, existingIds);
    }
    return {
      ok: false as const,
      error: {
        status: 409,
        code: "spec_exists",
        message: "Could not allocate a unique room ID. Try again.",
      },
    };
  }, [data.rooms, gateway, refresh]);

  const rooms = useMemo(
    () => data.rooms.map((room) => ({
      ...room,
      unread: room.unread && watermarks[room.spec.id] !== room.activityAt,
    })),
    [data.rooms, watermarks],
  );

  return { data: { ...data, rooms }, refresh, open, create };
}
