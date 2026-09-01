import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SailWireError } from "../../shared/types";
import type { Gateway } from "../gateway";
import { CatalogStore, catalogStore, connectCatalog } from "./catalogStore";
import {
  assembleRooms,
  readRoomWatermarks,
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

/**
 * The rooms sidebar's selector over the app-wide {@link catalogStore}: the
 * room+spec join assembled per render from the store's records, with unread
 * watermarks applied from localStorage — persistence remembers what you've
 * seen, never what exists. Mounting adopts the gateway into the store, so the
 * screen self-seeds when App hasn't wired the connection (tests, previews).
 */
export function useRooms(
  gateway: Gateway,
  storage: StorageLike = localStorage,
  store: CatalogStore = catalogStore,
) {
  useEffect(() => connectCatalog(gateway, store), [gateway, store]);
  const version = useSyncExternalStore(store.subscribe, () => store.version);
  const [watermarks, setWatermarks] = useState(() => readRoomWatermarks(storage));

  const data = useMemo<RoomsData>(() => {
    const serverRooms = store.roomList();
    return {
      rooms: assembleRooms(serverRooms ?? [], store.specList(), store.activityMap(), watermarks),
      projects: [
        ...new Set([...store.projects(), ...(serverRooms ?? []).map((room) => room.project)]),
      ].sort(),
      loading: store.loading,
      error: store.error,
    };
    // version is the store's change signal; the selectors read fresh state through it.
  }, [store, version, watermarks]);

  const refresh = useCallback(() => store.refreshAll(), [store]);

  const open = useCallback(
    (room: RoomView) => setWatermarks(visitRoom(storage, room)),
    [storage],
  );

  const create = useCallback(
    (title: string, project: string, agent?: string) => store.createRoom(title, project, agent),
    [store],
  );

  return { data, refresh, open, create };
}
