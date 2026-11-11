import { storedMap, type StorageLike } from "./rooms";

/**
 * What you have typed in each room and not sent: the one owner, in the presenceStore mold. A draft
 * belongs to its room and lives until it is sent or cleared, whatever changes on screen, so every
 * composer showing a room reads and writes it here; it is kept under {@link STORAGE_KEY} so it
 * outlives a restart.
 */

export const STORAGE_KEY = "mast.room.drafts";

class RoomDraftStore {
  private drafts: Readonly<Record<string, string>> = {};
  private storage: StorageLike | null = null;
  private readonly listeners = new Set<() => void>();

  /** Seeds the drafts from persistent storage; every later change is written back there. */
  connect(storage: StorageLike): void {
    this.storage = storage;
    this.drafts = storedMap(storage, STORAGE_KEY);
    this.emit();
  }

  readonly draft = (roomId: string): string => this.drafts[roomId] ?? "";

  /** Keeps `text` as the room's draft; an empty one is no draft. */
  keep(roomId: string, text: string): void {
    if (this.draft(roomId) === text) return;
    const { [roomId]: _replaced, ...others } = this.drafts;
    this.drafts = text ? { ...others, [roomId]: text } : others;
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.drafts));
    this.emit();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Test seam: no drafts and no storage attached, as a page starts. */
  reset(): void {
    this.storage = null;
    this.drafts = {};
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const roomDrafts = new RoomDraftStore();
