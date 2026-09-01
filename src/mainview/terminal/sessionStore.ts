import type { ConnectionStatus, SailEvent } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import { coalesce } from "../board/roomRouting";
import {
  type DeathRecord,
  type DeckSession,
  endedReasons,
  isPtyEvent,
  type SessionEntry,
} from "./roomDeck";

/**
 * The one owner of the pty session inventory, in the presenceStore mold: a
 * framework-free class singleton components subscribe to via
 * `useSyncExternalStore`. Every surface (room deck, route workbench, Terminal
 * view inventory, pane layout reconcile) reads this store; every mutation
 * (launch intent, kill) routes through it, so one surface's observation
 * converges all of them.
 *
 * State is box-keyed from day one: today one box exists (the single SSH
 * backend), but every read goes through the key so multi-box never forces a
 * second migration. The key derives from the connection target (see
 * {@link connectSessions}).
 *
 * Events accelerate, they never carry: pty events fold in optimistically and
 * kick a coalesced re-list, but correctness holds with the event lane fully
 * dead — the deterministic reconcile points are mutation acks, room/route
 * enter and leave, window focus, and stream reconnect.
 */

const KILLED_REASON = "closed from Mast";

type PendingCreate = {
  command: string[];
  room: string;
  /** The listing generation at launch — see the phantom rule in noteListing. */
  gen: number;
};

type BoxState = {
  gateway: Gateway;
  /** Null until the first listing lands. */
  listed: Map<string, DeckSession> | null;
  pending: Map<string, PendingCreate>;
  dying: Set<string>;
  refusals: Map<string, string>;
  deaths: Map<string, DeathRecord>;
  /** The last listing failure, or null; the skew card reads it. */
  skewReason: string | null;
  /** Listing generation counter — bumped per completed listing. */
  gen: number;
  /** Ended reasons from event history, the backfill for deaths observed before this app instance. */
  historyReasons: Map<string, string>;
  historyLoaded: Set<string>;
  /** Per-room issue counter for history reads; only the newest read's response lands. */
  historyRevisions: Map<string, number>;
  refresh: () => void;
};

export class SessionStore {
  /** Bumped on every observable change so `useSyncExternalStore` can read it. */
  version = 0;

  private boxes = new Map<string, BoxState>();
  private active: string | null = null;
  private listeners = new Set<() => void>();
  /** Rooms whose history was asked for before any box connected; drained on connect. */
  private wantedHistory = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private box(key = this.active): BoxState | undefined {
    return key === null ? undefined : this.boxes.get(key);
  }

  /**
   * Binds a gateway to a box key, makes it the active box, and takes the first
   * listing. State already held for the key (death records, listings) survives
   * a reconnect. Returns a disconnect that detaches the box.
   */
  connect(gateway: Gateway, boxKey: string): () => void {
    const existing = this.boxes.get(boxKey);
    const box: BoxState = existing
      ? { ...existing, gateway }
      : {
          gateway,
          listed: null,
          pending: new Map(),
          dying: new Set(),
          refusals: new Map(),
          deaths: new Map(),
          skewReason: null,
          gen: 0,
          historyReasons: new Map(),
          historyLoaded: new Set(),
          historyRevisions: new Map(),
          refresh: () => {},
        };
    box.refresh = coalesce(async () => {
      const result = await gateway.listSessions();
      if (this.boxes.get(boxKey) !== box) return;
      if (result.ok) this.noteListing(boxKey, result.value);
      else {
        box.skewReason = result.error.message;
        this.emit();
      }
    });
    this.boxes.set(boxKey, box);
    this.active = boxKey;
    this.emit();
    box.refresh();
    for (const roomId of this.wantedHistory) this.ensureHistory(roomId, boxKey);
    this.wantedHistory.clear();
    return () => {
      if (this.box(boxKey) === box) {
        box.refresh = () => {};
        if (this.active === boxKey) this.active = null;
      }
    };
  }

  get connected(): boolean {
    return this.box() !== undefined;
  }

  /** Coalesced re-list of the active box — the deterministic reconcile verb. */
  refresh(): void {
    this.box()?.refresh();
  }

  /**
   * The active box's inventory — listing truth overlaid with the store's own
   * transitions — or null until the first listing lands (a pending create
   * shows even before it: the surface that launched it must not wait).
   */
  sessions(key = this.active): SessionEntry[] | null {
    const box = this.box(key ?? undefined);
    if (!box) return null;
    if (box.listed === null && box.pending.size === 0) return null;
    const entries: SessionEntry[] = [];
    for (const [name, spec] of box.pending) {
      if (box.listed?.has(name)) continue;
      entries.push({
        name,
        live: true,
        attached: 0,
        writerFde: "",
        room: spec.room,
        command: spec.command,
        pending: true,
        ...this.marks(box, name),
      });
    }
    for (const [name, listed] of box.listed ?? []) {
      entries.push({ ...listed, ...this.marks(box, name) });
    }
    return entries;
  }

  private marks(box: BoxState, name: string): { dying?: boolean; refusal?: string } {
    const refusal = box.refusals.get(name);
    return {
      ...(box.dying.has(name) ? { dying: true } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    };
  }

  byName(name: string, key = this.active): SessionEntry | undefined {
    return this.sessions(key)?.find((s) => s.name === name);
  }

  deaths(key = this.active): ReadonlyMap<string, DeathRecord> {
    return this.box(key ?? undefined)?.deaths ?? new Map();
  }

  /** Ended reasons by session: death records first (authoritative), event history second. */
  reasons(key = this.active): Record<string, string> {
    const box = this.box(key ?? undefined);
    if (!box) return {};
    const merged: Record<string, string> = Object.fromEntries(box.historyReasons);
    for (const [name, death] of box.deaths) merged[name] = death.reason;
    return merged;
  }

  skewReason(key = this.active): string | null {
    return this.box(key ?? undefined)?.skewReason ?? null;
  }

  /**
   * Folds one completed listing in. The listing is the box's truth: a
   * previously-live name it dropped is an observed death, and so is any corpse
   * it lists — first-load corpses and live-to-dead transitions included, so a
   * later listing that drops the corpse can never read as an ordinary
   * host-restart loss and resurrect the pane. Every newly observed death is
   * recorded with the generic reason and tied to a fresh history read for its
   * room — never the name-wide reason cache, which a reused name would inherit
   * from its previous incarnation; the record stays `historyPending` (the
   * ended card fails closed) until that read settles it. Records are made
   * once, never overwriting a richer reason; a name listed live again is alive — its
   * death record is cleared so an external recreate is never pruned. Pending
   * creates ride until listed; one that two whole generations never confirmed
   * was a create that never happened and is dropped rather than haunting the
   * deck.
   */
  private noteListing(key: string, sessions: readonly DeckSession[]): void {
    const box = this.boxes.get(key)!;
    const next = new Map(sessions.map((s) => [s.name, s]));
    const staleRooms = new Set<string>();
    const recordDeath = (name: string, room: string, command: string[]) => {
      box.deaths.set(name, {
        reason: "ended",
        at: Date.now(),
        command,
        ...(room ? { room, historyPending: true } : {}),
      });
      if (room) staleRooms.add(room);
    };
    for (const [name, prev] of box.listed ?? []) {
      if (prev.live && !next.has(name) && !box.deaths.has(name)) {
        recordDeath(name, prev.room, prev.command);
      }
    }
    for (const s of sessions) {
      if (s.live) {
        box.deaths.delete(s.name);
      } else if (!box.deaths.has(s.name)) {
        recordDeath(s.name, s.room, s.command);
      }
    }
    for (const [, death] of box.deaths) {
      // A pending record whose read failed retries at the next reconcile point.
      if (death.historyPending && death.room && !box.historyLoaded.has(death.room)) {
        staleRooms.add(death.room);
      }
    }
    for (const room of staleRooms) this.refreshHistory(box, room);
    box.listed = next;
    box.gen++;
    for (const [name, spec] of box.pending) {
      if (next.has(name) || box.gen - spec.gen >= 2) box.pending.delete(name);
    }
    for (const name of box.dying) {
      if (!next.has(name) && !box.pending.has(name)) box.dying.delete(name);
    }
    for (const name of box.refusals.keys()) {
      if (!next.has(name) && !box.pending.has(name)) box.refusals.delete(name);
    }
    box.skewReason = null;
    this.emit();
  }

  /**
   * A live pty event folds in optimistically — a start shows the session
   * before the re-list lands, an end records the death with the server's
   * reason (richer than any local guess, so it overwrites) — but the caller
   * pairs it with a refresh; the listing stays the truth.
   */
  noteEvent(event: SailEvent, key = this.active): void {
    if (!isPtyEvent(event)) return;
    const box = this.box(key ?? undefined);
    if (!box) return;
    const name = typeof event.data?.session === "string" ? event.data.session : null;
    if (!name) return;
    if (event.type === "pty_session_ended") {
      const reason = typeof event.data?.reason === "string" ? event.data.reason : "ended";
      const known = box.listed?.get(name);
      // The end cancels any optimistic start: a surviving pending entry would
      // read as live and mount a create-capable pane over the corpse.
      const pending = box.pending.get(name);
      box.pending.delete(name);
      const command = known?.command ?? pending?.command;
      box.deaths.set(name, {
        reason,
        at: Date.now(),
        ...(command ? { command } : {}),
      });
      if (known?.live) box.listed!.set(name, { ...known, live: false });
      this.emit();
      return;
    }
    if (event.type === "pty_session_started") {
      box.deaths.delete(name);
      if (!box.listed?.has(name) && !box.pending.has(name)) {
        const room =
          typeof event.data?.room_id === "string"
            ? event.data.room_id
            : typeof event.spec === "string"
              ? event.spec
              : "";
        const executable = typeof event.data?.executable === "string" ? event.data.executable : "";
        box.pending.set(name, {
          command: executable ? [executable] : ["bash", "-l"],
          room,
          gen: box.gen,
        });
      }
      this.emit();
    }
  }

  /**
   * A deliberate create (open, launch, revive): the intent shows in every
   * surface immediately, and it clears the name's death record — reviving a
   * corpse must not leave a tombstone that would prune the new pane.
   */
  noteLaunch(name: string, command: string[], room: string, key = this.active): void {
    const box = this.box(key ?? undefined);
    if (!box) return;
    box.pending.set(name, { command, room, gen: box.gen });
    box.deaths.delete(name);
    box.refusals.delete(name);
    this.emit();
  }

  /**
   * The one kill path. Optimistic dying mark, then the gateway call; the ack
   * removes the entry, records the death, and re-lists; a refusal (the box
   * said no, or the fail-closed room guard below) lands INLINE on the entry —
   * never a silent return.
   *
   * The guard: a room-bound session killed without `resolvedRoom` context (the
   * whole-box inventory) resolves its room first — a session whose room the
   * control plane can't resolve is left alone, visibly. Callers inside the
   * room pass `resolvedRoom`: the route already resolved it, and a pty-only
   * degraded link must still close its own panes.
   */
  async kill(
    name: string,
    opts: { resolvedRoom?: string } = {},
    key = this.active,
  ): Promise<{ ok: boolean; refusal?: string }> {
    const box = this.box(key ?? undefined);
    if (!box) return { ok: false, refusal: "no box connected" };
    const refuse = (refusal: string) => {
      box.dying.delete(name);
      box.refusals.set(name, refusal);
      this.emit();
      return { ok: false, refusal };
    };
    const entry = this.byName(name, key);
    box.refusals.delete(name);
    box.dying.add(name);
    this.emit();
    if (entry?.room && entry.room !== opts.resolvedRoom) {
      const room = await box.gateway.getRoom(entry.room);
      if (!room.ok) return refuse(`room ${entry.room} unresolved: ${room.error.message}`);
      if (room.value.id !== entry.room) return refuse(`room ${entry.room} unresolved`);
    }
    const result = await box.gateway.killSession(name);
    if (!result.ok) return refuse(result.error.message);
    box.dying.delete(name);
    box.pending.delete(name);
    box.listed?.delete(name);
    box.deaths.set(name, {
      reason: KILLED_REASON,
      at: Date.now(),
      ...(entry ? { command: entry.command } : {}),
    });
    this.emit();
    box.refresh();
    return { ok: true };
  }

  /**
   * Backfills a room's ended reasons from its durable event history, once per
   * room per box — deaths this instance never saw. Rooms asked for before the
   * box connects are remembered and drained on connect.
   */
  ensureHistory(roomId: string, key = this.active): void {
    const box = this.box(key ?? undefined);
    if (!box) {
      this.wantedHistory.add(roomId);
      return;
    }
    if (box.historyLoaded.has(roomId)) return;
    this.refreshHistory(box, roomId);
  }

  /**
   * One fresh history read for a room, revision-tagged: a response that is not
   * the room's newest issued read is discarded whole — a death recorded while
   * it was in flight forced a newer read, and the older response could pin a
   * reused name to its previous incarnation's reason. The surviving response
   * settles every pending death in the room: the durable reason when the
   * history holds one, else the generic reason stands verified; either way the
   * pending mark clears and the ended card ungates. A failed read keeps the
   * mark (fail closed) and retries at the next reconcile point.
   */
  private refreshHistory(box: BoxState, roomId: string): void {
    const revision = (box.historyRevisions.get(roomId) ?? 0) + 1;
    box.historyRevisions.set(roomId, revision);
    box.historyLoaded.add(roomId);
    void box.gateway.specEvents(roomId).then((result) => {
      if (box.historyRevisions.get(roomId) !== revision) return;
      if (!result.ok) {
        box.historyLoaded.delete(roomId);
        return;
      }
      const durable = endedReasons(result.value.events);
      for (const [name, reason] of Object.entries(durable)) box.historyReasons.set(name, reason);
      for (const [name, death] of box.deaths) {
        if (death.room === roomId && death.historyPending) {
          const { historyPending: _settled, ...record } = death;
          box.deaths.set(name, { ...record, reason: durable[name] ?? death.reason });
        } else if (death.reason === "ended" && durable[name]) {
          box.deaths.set(name, { ...death, reason: durable[name]! });
        }
      }
      this.emit();
    });
  }

  /** Test seam: drops every box. */
  reset(): void {
    this.boxes.clear();
    this.active = null;
    this.wantedHistory.clear();
    this.emit();
  }
}

/** The app-wide instance; wired to the gateway in App via {@link connectSessions}. */
export const sessionStore = new SessionStore();

/** The box key: the connection target — one SSH backend, one box. */
export function boxKeyOf(status: Pick<ConnectionStatus, "server">): string {
  return status.server;
}

/**
 * Wires `store` to a gateway beside connectPresence: resolves the box key from
 * the connection target, takes the first listing, and arms the accelerator and
 * reconcile lanes — pty events (fold + re-list), stream reconnect, and window
 * focus. Correctness never rides the event lane; killing every subscription
 * here still leaves the store converging on its deterministic reconcile
 * points. Returns the teardown.
 */
export function connectSessions(gateway: Gateway, store: SessionStore): () => void {
  let disposed = false;
  let teardown: Array<() => void> = [];
  void gateway.connection().then((status) => {
    if (disposed) return;
    const key = boxKeyOf(status);
    const disconnect = store.connect(gateway, key);
    const offEvent = gateway.onEvent((event) => {
      if (!isPtyEvent(event)) return;
      store.noteEvent(event, key);
      store.refresh();
    });
    const offStatus = gateway.onConnectionStatus((next) => {
      if (next.phase === "ready") store.refresh();
    });
    const onFocus = () => store.refresh();
    window.addEventListener("focus", onFocus);
    teardown = [disconnect, offEvent, offStatus, () => window.removeEventListener("focus", onFocus)];
  });
  return () => {
    disposed = true;
    for (const off of teardown) off();
  };
}
