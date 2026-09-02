import type {
  DispatchRequest,
  DispatchResponse,
  DisengageResponse,
  EngageRequest,
  EngageResponse,
  GlobalSpecDetailResponse,
  GlobalSpecView,
  RunView,
  SailEvent,
  ServerRoomView,
  SpecStatus,
  SpecUpdateRequest,
  StopRunResponse,
} from "../../shared/sail-models";
import type { SailResult, SailWireError } from "../../shared/types";
import type { Gateway } from "../gateway";
import { RUN_CHANGE_TYPES } from "./notifyPolicy";
import { coalesce } from "./roomRouting";
import { foldActivity, isRoomActivityEvent, roomIdFromTitle } from "./rooms";

/**
 * The one owner of the rooms/specs/projects catalog and per-spec run lists, in
 * the presenceStore mold: a framework-free class singleton components subscribe
 * to via `useSyncExternalStore`. Rooms, specs, and projects are one aggregate —
 * rooms join specs through `spec_ids`, projects derive from both plus the
 * synced roster, and run lists hang off specs — so one store owns them and no
 * surface needs a cross-store join. `useRooms`/`useBoard` are selectors over
 * it; mutations (create room, spec moves/edits, dispatch, engage/disengage,
 * stop) route through it and reconcile on their acks.
 *
 * Events accelerate, they never carry: a live event refreshes exactly the
 * state it names — a spec event refetches that spec (and its room when new), a
 * message event bumps that room, a run event re-lists that spec's runs —
 * `board_updated` is the only full-refresh trigger, and an unrecognized record
 * event naming a spec falls back to refetching that spec so a new server event
 * type is never silently dropped. Correctness holds with the event lane fully
 * dead: the deterministic reconcile points are the per-connection seed, stream
 * reconnect, window focus, and every mutation ack.
 */

export type MoveOutcome = "ok" | "conflict" | "blocked" | "error";
export type MoveResult = { outcome: MoveOutcome; error?: SailWireError };

export type CreateRoomResult =
  | { ok: true; value: ServerRoomView; engageError?: string }
  | { ok: false; error: SailWireError };

/** Event families whose state another store owns (sessions, snapshots,
 *  presence/runs): they only bump room activity here — refetching a spec for a
 *  pty or tool event would put a getSpec behind every terminal keystroke burst. */
const FOREIGN_EVENT_TYPES = /^(pty_session_|snapshot_|agent_)/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** True when `incoming` may replace `existing`: an equally fresh or fresher
 *  row wins; a row a racing slow fetch read before the current one never
 *  drags state backward. */
function fresherOrSame(
  existing: { updated_at: string } | undefined,
  incoming: { updated_at: string },
): boolean {
  return !existing || timestamp(incoming.updated_at) >= timestamp(existing.updated_at);
}

export class CatalogStore {
  /** Bumped on every observable change so `useSyncExternalStore` can read it. */
  version = 0;

  private listeners = new Set<() => void>();
  private gateway: Gateway | null = null;
  private teardown: Array<() => void> = [];

  private roomsById: Map<string, ServerRoomView> | null = null;
  private specsById = new Map<string, GlobalSpecView>();
  private specsSeeded = false;
  private etags = new Map<string, string>();
  private catalogProjects: string[] = [];
  private activity = new Map<string, string>();
  private fde: string | undefined;
  private roomsError: SailWireError | null = null;
  private specsError: SailWireError | null = null;

  private runsBySpec = new Map<string, RunView[]>();
  private runHolds = new Map<string, number>();
  /** Per-spec slice generation, bumped at every invalidation boundary so a
   *  listing that started before the boundary can never repopulate the cache. */
  private runsGen = new Map<string, number>();

  /** Per-spec scoped-request generation: only the newest getSpec for an id is
   *  authoritative, and every accepted upsert (mutation acks included)
   *  advances it, so a delayed older fetch — success or 404 — can never undo
   *  newer scoped state. The epoch fences accounts; this orders requests. */
  private specRequestGen = new Map<string, number>();

  private specRefreshers = new Map<string, () => void>();
  private roomRefreshers = new Map<string, () => void>();
  private runRefreshers = new Map<string, () => void>();
  private worldRefresher: () => void = () => {};
  private gen = 0;
  /** Bumped by reset(): every async completion checks it before writing, so a
   *  request begun under one sign-in can never land in the next one's store.
   *  Gateway object identity is not enough — App reuses one Gateway object
   *  across logout/login, so an account-A request resolving after account B
   *  reconnects would pass an identity check. */
  private epoch = 0;
  /** Bumped on every accepted scoped merge (upsert or 404 removal) so a full
   *  snapshot that overlapped one knows its presence/absence verdicts are
   *  stale and re-runs instead of undoing the newer scoped state. */
  private recordRevision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Binds the store to a gateway: seeds the world, and arms the accelerator
   * and reconcile lanes (events, stream-ready, window focus). Idempotent per
   * gateway — App wires it once per connection and every selector hook calls
   * it too, so a screen rendered without App (tests, previews) self-seeds; a
   * NEW gateway tears the old wiring down and starts from scratch.
   */
  connect(gateway: Gateway): void {
    if (this.gateway === gateway) return;
    this.reset();
    this.gateway = gateway;
    this.worldRefresher = coalesce(() => this.fetchWorld(gateway));
    const onFocus = () => this.refreshAll();
    window.addEventListener("focus", onFocus);
    this.teardown = [
      gateway.onEvent((event) => this.noteEvent(event)),
      gateway.onConnectionStatus((status) => {
        if (status.phase === "ready") this.refreshAll();
      }),
      () => window.removeEventListener("focus", onFocus),
    ];
    this.refreshAll();
  }

  /** Test seam: drops the gateway wiring and every record. */
  reset(): void {
    for (const off of this.teardown) off();
    this.teardown = [];
    this.gateway = null;
    this.worldRefresher = () => {};
    this.gen++;
    this.epoch++;
    this.roomsById = null;
    this.specsById = new Map();
    this.specsSeeded = false;
    this.etags = new Map();
    this.catalogProjects = [];
    this.activity = new Map();
    this.fde = undefined;
    this.roomsError = null;
    this.specsError = null;
    this.runsBySpec = new Map();
    // Holds are component INTEREST, not cached data: they outlive the reset so
    // still-mounted surfaces get their slices reseeded on the next connect
    // (refreshAll re-kicks every held id), and their release closures keep
    // balancing against the same registry. Only the data and its generations
    // are dropped.
    for (const specId of this.runHolds.keys()) {
      this.runsGen.set(specId, (this.runsGen.get(specId) ?? 0) + 1);
    }
    this.specRequestGen = new Map();
    this.specRefreshers = new Map();
    this.roomRefreshers = new Map();
    this.runRefreshers = new Map();
    this.emit();
  }

  /** Coalesced re-seed of the whole aggregate — the conservative reconcile
   *  verb. Identity rides along: "assignee: me" matches nobody until whoami
   *  lands, so a transient failure must retry here, not stay broken for the
   *  connection's lifetime. */
  refreshAll(): void {
    this.worldRefresher();
    for (const specId of this.runHolds.keys()) this.kickRuns(specId);
    const gateway = this.gateway;
    if (!gateway) return;
    const epoch = this.epoch;
    void gateway.whoami().then((result) => {
      if (this.epoch !== epoch || !result.ok || this.fde === result.value.fde) return;
      this.fde = result.value.fde;
      this.emit();
    });
  }

  /**
   * The seed and the full-refresh path: rooms and specs first — the page
   * paints from them — then the project roster and recent activity merge in as
   * they land, so a hung roster or event log never blanks the rooms.
   */
  private async fetchWorld(gateway: Gateway): Promise<void> {
    const gen = ++this.gen;
    const revision = this.recordRevision;
    const recentPromise = gateway.recentEvents(500).catch(() => null);
    const catalogPromise = gateway
      .listProjects()
      .then((result) =>
        result.ok && Array.isArray(result.value.projects)
          ? result.value.projects.map((project) => project.name)
          : [],
      )
      .catch(() => []);
    const rejected = (error: unknown) => ({
      ok: false as const,
      error: { status: 0, code: "bridge", message: message(error) } satisfies SailWireError,
    });
    const [roomsResult, specsResult] = await Promise.all([
      gateway.listRooms().catch(rejected),
      gateway.listSpecs({}).catch(rejected),
    ]);
    if (gen !== this.gen) return;
    // A scoped merge that landed while the lists were in flight already knows
    // more than this snapshot about what exists: the older lists must not
    // drop an event-inserted record or resurrect a 404-removed one, so the
    // whole snapshot is discarded and refetched.
    if (revision !== this.recordRevision) return this.worldRefresher();
    // Rooms and specs fail independently: the board must survive a rooms
    // endpoint that errors (or predates this app), and vice versa — whichever
    // listing landed is applied, the other lane carries its own error.
    if (roomsResult.ok) {
      this.roomsError = null;
      const previousRooms = this.roomsById;
      this.roomsById = new Map(
        roomsResult.value.rooms.map((room) => {
          const existing = previousRooms?.get(room.id);
          return [room.id, existing && !fresherOrSame(existing, room) ? existing : room];
        }),
      );
    } else {
      this.roomsError = roomsResult.error;
    }
    if (specsResult.ok) {
      this.specsError = null;
      const previousSpecs = this.specsById;
      this.specsById = new Map(
        specsResult.value.specs.map((spec) => {
          const existing = previousSpecs.get(spec.id);
          return [spec.id, existing && !fresherOrSame(existing, spec) ? existing : spec];
        }),
      );
      // The snapshot outranks every scoped request already in flight: bump the
      // request generation for every id it speaks for — listed rows (a stale
      // 404 must not delete them) and rows it removed (a stale success must
      // not resurrect them).
      for (const spec of specsResult.value.specs) this.bumpSpecGen(spec.id);
      for (const id of previousSpecs.keys()) {
        if (!this.specsById.has(id)) this.bumpSpecGen(id);
      }
      this.specsSeeded = true;
    } else {
      this.specsError = specsResult.error;
    }
    this.emit();

    const [recent, catalog] = await Promise.all([recentPromise, catalogPromise]);
    if (gen !== this.gen) return;
    this.catalogProjects = catalog;
    if (recent?.ok) foldActivity(this.activity, recent.value.events);
    this.emit();
  }

  /**
   * Folds one live event in by refetching exactly what it names; see the
   * class doc for the vocabulary. Non-record noise (tool progress, presence,
   * log chunks) is the presence store's lane and is ignored here.
   */
  noteEvent(event: SailEvent): void {
    if (event.type === "board_updated") return this.refreshAll();
    const specId = event.spec;
    if (RUN_CHANGE_TYPES.has(event.type)) {
      if (specId) this.kickHeldRuns(specId);
      else for (const held of this.runHolds.keys()) this.kickRuns(held);
    }
    if (!specId || !isRoomActivityEvent(event)) return;
    this.bumpActivity(specId, event.ts);
    if (event.type === "spec_message_posted") return this.kickRoom(specId);
    if (FOREIGN_EVENT_TYPES.test(event.type)) return;
    this.kickSpec(specId);
  }

  private bumpActivity(roomId: string, ts: string): void {
    const current = this.activity.get(roomId);
    if (current && timestamp(current) >= timestamp(ts)) return;
    this.activity.set(roomId, ts);
    this.emit();
  }

  private kickSpec(id: string): void {
    let kick = this.specRefreshers.get(id);
    if (!kick) {
      kick = coalesce(() => this.refreshSpec(id).then(() => {}));
      this.specRefreshers.set(id, kick);
    }
    kick();
  }

  private kickRoom(id: string): void {
    let kick = this.roomRefreshers.get(id);
    if (!kick) {
      kick = coalesce(() => this.fetchRoom(id));
      this.roomRefreshers.set(id, kick);
    }
    kick();
  }

  private kickHeldRuns(specId: string): void {
    if (this.runHolds.has(specId)) this.kickRuns(specId);
  }

  private kickRuns(specId: string): void {
    let kick = this.runRefreshers.get(specId);
    if (!kick) {
      kick = coalesce(() => this.fetchRuns(specId));
      this.runRefreshers.set(specId, kick);
    }
    kick();
  }

  /**
   * Refetches one spec and folds it in — the store's scoped merge verb, also
   * the detail page's loader (it needs the response's body and ETag). A 404
   * removes the row: the spec is gone, only the backend says so. A spec whose
   * room the store has never seen brings that room in with it.
   */
  async refreshSpec(id: string): Promise<SailResult<GlobalSpecDetailResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const request = (this.specRequestGen.get(id) ?? 0) + 1;
    this.specRequestGen.set(id, request);
    const result = await gateway.getSpec(id);
    if (this.epoch !== epoch || this.specRequestGen.get(id) !== request) return result;
    if (!result.ok) {
      if (result.error.status === 404) {
        // An authoritative absence verdict even when the row was never here:
        // a full-list snapshot in flight may still carry the dead spec, and
        // only the revision bump stops it from inserting a ghost.
        this.recordRevision++;
        if (this.specsById.delete(id)) {
          this.etags.delete(id);
          this.emit();
        }
      }
      return result;
    }
    this.upsertSpec(result.value.spec, result.etag);
    const roomId = result.value.spec.room_id ?? result.value.spec.id;
    if (this.roomsById !== null && !this.roomsById.has(roomId)) this.kickRoom(roomId);
    return result;
  }

  /** Invalidates every scoped spec request in flight for {@code id}. */
  private bumpSpecGen(id: string): void {
    this.specRequestGen.set(id, (this.specRequestGen.get(id) ?? 0) + 1);
  }

  private async fetchRoom(id: string): Promise<void> {
    const gateway = this.gateway;
    if (!gateway || this.roomsById === null) return;
    const epoch = this.epoch;
    const result = await gateway.getRoom(id);
    if (this.epoch !== epoch || this.roomsById === null || !result.ok) return;
    this.upsertRoom(result.value);
  }

  /** Forgets a spec's cached run list so the next read is unknown, and bumps
   *  the slice generation so a listing already in flight when the boundary
   *  passed cannot repopulate the cache with a pre-boundary answer. */
  private invalidateRuns(specId: string): void {
    this.runsGen.set(specId, (this.runsGen.get(specId) ?? 0) + 1);
    if (this.runsBySpec.delete(specId)) this.emit();
  }

  private async fetchRuns(specId: string): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) return;
    this.invalidateRuns(specId);
    const epoch = this.epoch;
    const gen = this.runsGen.get(specId);
    const result = await gateway.listRuns(specId);
    if (this.epoch !== epoch || this.runsGen.get(specId) !== gen) return;
    if (!result.ok || !Array.isArray(result.value.runs)) return;
    this.runsBySpec.set(specId, result.value.runs);
    this.emit();
  }

  private upsertSpec(spec: GlobalSpecView, etag?: string): void {
    if (!fresherOrSame(this.specsById.get(spec.id), spec)) return;
    this.specsById.set(spec.id, spec);
    if (etag !== undefined) this.etags.set(spec.id, etag);
    this.bumpSpecGen(spec.id);
    this.recordRevision++;
    this.emit();
  }

  private upsertRoom(room: ServerRoomView): void {
    if (this.roomsById === null) this.roomsById = new Map();
    if (!fresherOrSame(this.roomsById.get(room.id), room)) return;
    this.roomsById.set(room.id, room);
    this.recordRevision++;
    this.emit();
  }

  /* ----------------------------- selectors ------------------------------ */

  get connected(): boolean {
    return this.gateway !== null;
  }

  /** True once the world's spec list has landed at least once — readiness
   *  verdicts (dependency gates, empty states) are guesses before this. */
  get seeded(): boolean {
    return this.specsSeeded;
  }

  get loading(): boolean {
    return (
      this.roomsById === null &&
      !this.specsSeeded &&
      this.roomsError === null &&
      this.specsError === null
    );
  }

  /** The rooms surface's error: its own lane first, the spec lane's second
   *  (the sidebar joins both, so either failing degrades it). */
  get error(): SailWireError | null {
    return this.roomsError ?? this.specsError;
  }

  /** The board's error: the spec lane only — the board never read rooms. */
  get boardError(): SailWireError | null {
    return this.specsError;
  }

  /** The caller's FDE handle, once whoami lands — resolves "assignee: me". */
  get me(): string | undefined {
    return this.fde;
  }

  /** Null until the first listing lands. */
  roomList(): ServerRoomView[] | null {
    return this.roomsById === null ? null : [...this.roomsById.values()];
  }

  specList(): GlobalSpecView[] {
    return [...this.specsById.values()];
  }

  specOf(id: string): GlobalSpecView | undefined {
    return this.specsById.get(id);
  }

  etagOf(id: string): string | undefined {
    return this.etags.get(id);
  }

  /** Synced project-roster names; surfaces union in their own derivations. */
  projects(): string[] {
    return this.catalogProjects;
  }

  /** Room id → newest record-event timestamp, for activity/unread assembly. */
  activityMap(): ReadonlyMap<string, string> {
    return this.activity;
  }

  /** Null while the spec is unheld, until a listing lands under the current
   *  hold, and again while a refresh is in flight or after one fails — a
   *  stale or leftover list must never stand as evidence that no dispatch is
   *  active. Consumers gating on runs (Reopen after a yielded dispatch) fail
   *  closed on null and the store retries at every reconcile point. */
  runsOf(specId: string): RunView[] | null {
    return this.runHolds.has(specId) ? (this.runsBySpec.get(specId) ?? null) : null;
  }

  /**
   * Declares interest in one spec's run list: fetches it, keeps it fresh on
   * run events and reconcile points while held, and returns the release.
   * Both hold boundaries invalidate the slice — the answer a previous holder
   * saw is not evidence for the next one.
   */
  retainRuns(specId: string): () => void {
    const firstHold = !this.runHolds.has(specId);
    this.runHolds.set(specId, (this.runHolds.get(specId) ?? 0) + 1);
    if (firstHold) this.invalidateRuns(specId);
    this.kickRuns(specId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const holds = (this.runHolds.get(specId) ?? 1) - 1;
      if (holds > 0) return void this.runHolds.set(specId, holds);
      this.runHolds.delete(specId);
      this.invalidateRuns(specId);
    };
  }

  /* ----------------------------- mutations ------------------------------ */

  /**
   * Creates a room (id derived from the title, suffixed past creation races),
   * optionally seats an agent in it. The created room folds in on the ack; an
   * engage failure travels back loud beside the successful create.
   */
  async createRoom(title: string, project: string, agent?: string): Promise<CreateRoomResult> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const trimmed = title.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: { status: 0, code: "invalid_title", message: "Enter a room title." },
      };
    }
    if (!project) {
      return {
        ok: false,
        error: { status: 0, code: "invalid_project", message: "Choose a project." },
      };
    }
    const existingIds = new Set(this.roomsById?.keys() ?? []);
    let id: string;
    try {
      id = roomIdFromTitle(trimmed, existingIds);
    } catch (error) {
      return {
        ok: false,
        error: { status: 0, code: "invalid_title", message: message(error) },
      };
    }
    const epoch = this.epoch;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await gateway.createRoom({ id, project, title: trimmed });
      // The epoch fences the network too, not just the store: past a
      // logout/login boundary this operation must not engage an agent or
      // retry the creation under whoever signed in next.
      if (this.epoch !== epoch) {
        return {
          ok: false,
          error: { status: 0, code: "session_changed", message: "The signed-in session changed." },
        };
      }
      if (result.ok) {
        this.upsertRoom(result.value);
        let engageError: string | undefined;
        if (agent) {
          const engaged = await gateway.engage(id, { agent });
          if (!engaged.ok) engageError = engaged.error.message;
          if (this.epoch === epoch) this.kickRoom(id);
        }
        return engageError ? { ...result, engageError } : result;
      }
      if (result.error.status !== 409) return result;
      existingIds.add(id);
      id = roomIdFromTitle(trimmed, existingIds);
    }
    return {
      ok: false,
      error: {
        status: 409,
        code: "conflict",
        message: "Could not allocate a unique room ID. Try again.",
      },
    };
  }

  /** Metadata write; the ack's spec (and fresh ETag) fold straight in. */
  async updateSpec(
    id: string,
    request: SpecUpdateRequest,
    ifMatch?: string,
  ): Promise<SailResult<GlobalSpecDetailResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const result = await gateway.updateSpec(id, request, ifMatch);
    if (result.ok && this.epoch === epoch) this.upsertSpec(result.value.spec, result.etag);
    return result;
  }

  /**
   * The board's lane move: If-Match from the row captured here, so a
   * concurrent writer surfaces as a conflict (and a scoped refetch of that
   * spec), never an overwrite.
   */
  async moveSpec(id: string, to: SpecStatus): Promise<MoveResult> {
    const spec = this.specsById.get(id);
    if (!spec) return { outcome: "error" };
    const result = await this.updateSpec(id, { status: to }, `"${spec.updated_at}"`);
    if (result.ok) return { outcome: "ok" };
    if (result.error.status === 412) {
      this.kickSpec(id);
      return { outcome: "conflict", error: result.error };
    }
    return { outcome: "error", error: result.error };
  }

  /** Restore to a revision; the ack folds in like any metadata write. */
  async restoreSpec(id: string, rev: number): Promise<SailResult<GlobalSpecDetailResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const result = await gateway.restoreSpec(id, rev);
    if (result.ok && this.epoch === epoch) this.upsertSpec(result.value.spec, result.etag);
    return result;
  }

  /** Launch a run; the ack refetches the named spec and its held run list. */
  async dispatch(
    project: string,
    request: DispatchRequest,
  ): Promise<SailResult<DispatchResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const result = await gateway.dispatch(project, request);
    if (result.ok && this.epoch === epoch && request.spec_id) {
      this.kickSpec(request.spec_id);
      this.kickHeldRuns(request.spec_id);
    }
    return result;
  }

  /** Seat an agent in a room; the ack refetches the room and its spec. */
  async engage(roomId: string, request: EngageRequest): Promise<SailResult<EngageResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const result = await gateway.engage(roomId, request);
    if (result.ok && this.epoch === epoch) this.reconcileRoom(roomId);
    return result;
  }

  /** Dismiss the room's agent; same scoped reconcile as engage. */
  async disengage(roomId: string): Promise<SailResult<DisengageResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const result = await gateway.disengage(roomId);
    if (result.ok && this.epoch === epoch) this.reconcileRoom(roomId);
    return result;
  }

  /** Clean-stop a run; the ack refetches the spec (status may flip) and runs. */
  async stopRun(runId: string, specId: string): Promise<SailResult<StopRunResponse>> {
    const gateway = this.gateway;
    if (!gateway) {
      return { ok: false, error: { status: 0, code: "bridge", message: "no gateway connected" } };
    }
    const epoch = this.epoch;
    const result = await gateway.stopRun(runId);
    if (result.ok && this.epoch === epoch) {
      this.kickSpec(specId);
      this.kickHeldRuns(specId);
    }
    return result;
  }

  /** A room mutation touches the room row and, when the room hosts a spec,
   *  that spec's row (engagement lives on both views). */
  private reconcileRoom(roomId: string): void {
    this.kickRoom(roomId);
    if (this.specsById.has(roomId)) return this.kickSpec(roomId);
    for (const spec of this.specsById.values()) {
      if (spec.room_id === roomId) return this.kickSpec(spec.id);
    }
  }
}

/** The app-wide instance; wired in App and adopted by the selector hooks. */
export const catalogStore = new CatalogStore();

/** Ensures `store` is wired to `gateway`; idempotent, so App and every
 *  selector hook may call it — the first caller wins the seeding. */
export function connectCatalog(gateway: Gateway, store: CatalogStore = catalogStore): void {
  store.connect(gateway);
}
