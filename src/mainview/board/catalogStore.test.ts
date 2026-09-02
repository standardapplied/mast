import { describe, expect, test } from "bun:test";
import type { RunView, SailEvent } from "../../shared/sail-models";
import { createDemoGateway, type DemoGateway, type Gateway } from "../gateway";
import { CatalogStore } from "./catalogStore";

/**
 * The bounded-refetch contract: an event refreshes exactly the state it
 * names. Call counts on the gateway fake are the assertion — an event for one
 * spec is one getSpec, never a listSpecs-the-world.
 */

const COUNTED = [
  "listRooms",
  "listSpecs",
  "listProjects",
  "recentEvents",
  "getSpec",
  "getRoom",
  "listRuns",
] as const;

type Counted = (typeof COUNTED)[number];
type Counts = Record<Counted, number>;

function counted(gateway: DemoGateway): { gateway: DemoGateway; counts: Counts } {
  const counts = Object.fromEntries(COUNTED.map((name) => [name, 0])) as Counts;
  for (const name of COUNTED) {
    const original = gateway[name].bind(gateway) as (...args: unknown[]) => unknown;
    (gateway as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      counts[name]++;
      return original(...args);
    };
  }
  return { gateway, counts };
}

const settle = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function seeded() {
  const { gateway, counts } = counted(createDemoGateway());
  const store = new CatalogStore();
  store.connect(gateway);
  await settle();
  await settle();
  return { gateway, counts, store };
}

/** Seeded with the event lane dead — mutation acks alone must reconcile. */
async function seededQuiet() {
  const gateway = createDemoGateway();
  gateway.onEvent = () => () => {};
  const { counts } = counted(gateway);
  const store = new CatalogStore();
  store.connect(gateway);
  await settle();
  await settle();
  return { gateway, counts, store };
}

const demoRun = (specId: string, status: string): RunView => ({
  id: `run-${specId}-${status}`,
  project: "chorus",
  spec_id: specId,
  node: "demo",
  role: "build",
  agent: "claude-code",
  status,
  started_at: "2026-07-08T11:30:00Z",
});

const event = (partial: Partial<SailEvent>): SailEvent => ({
  v: 1,
  id: 9000 + Math.floor(Math.random() * 1000),
  ts: "2026-07-02T12:00:00Z",
  project: "chorus",
  type: "spec_status_changed",
  agent: "sail",
  host: "demo",
  ...partial,
});

describe("CatalogStore seeding", () => {
  test("one connection seeds the world exactly once", async () => {
    const { counts, store } = await seeded();
    expect(counts.listRooms).toBe(1);
    expect(counts.listSpecs).toBe(1);
    expect(counts.listProjects).toBe(1);
    expect(counts.recentEvents).toBe(1);
    expect(store.loading).toBe(false);
    expect(store.seeded).toBe(true);
    expect(store.roomList()!.length).toBeGreaterThan(7);
    expect(store.specList().length).toBe(11);
    expect(store.projects()).toEqual(["chorus", "nautilus", "sail-mast"]);
    expect(store.me).toBe("uday");
  });

  test("reconnecting the same gateway is a no-op; a new gateway reseeds fresh", async () => {
    const { gateway, counts, store } = await seeded();
    store.connect(gateway);
    await settle();
    expect(counts.listSpecs).toBe(1);

    const second = counted(createDemoGateway());
    store.connect(second.gateway);
    await settle();
    await settle();
    expect(second.counts.listSpecs).toBe(1);
    expect(store.specList().length).toBe(11);

    await gateway.postSpecMessage("chorus-billing-export", { body: "stale lane" });
    await settle();
    expect(second.counts.getRoom).toBe(0);
  });

  test("a failing rooms endpoint degrades the rooms lane, never the board", async () => {
    const gateway = createDemoGateway();
    gateway.listRooms = async () => ({
      ok: false,
      error: { status: 404, code: "not_found", message: "no rooms endpoint" },
    });
    const store = new CatalogStore();
    store.connect(gateway);
    await settle();
    expect(store.seeded).toBe(true);
    expect(store.specList().length).toBe(11);
    expect(store.boardError).toBeNull();
    expect(store.error?.message).toBe("no rooms endpoint");
  });

  test("a rejecting listing surfaces a bridge error instead of hanging", async () => {
    const gateway = createDemoGateway();
    gateway.listSpecs = () => Promise.reject(new Error("bridge died"));
    const store = new CatalogStore();
    store.connect(gateway);
    await settle();
    expect(store.loading).toBe(false);
    expect(store.error?.code).toBe("bridge");
    expect(store.error?.message).toContain("bridge died");
  });

  test("a thrown rooms request degrades only the rooms lane — specs still land", async () => {
    const gateway = createDemoGateway();
    gateway.listRooms = () => Promise.reject(new Error("rooms bridge died"));
    const store = new CatalogStore();
    store.connect(gateway);
    await settle();
    expect(store.seeded).toBe(true);
    expect(store.specList().length).toBe(11);
    expect(store.boardError).toBeNull();
    expect(store.error?.code).toBe("bridge");
    expect(store.error?.message).toContain("rooms bridge died");
  });

  test("a transient whoami failure recovers at the next reconcile point", async () => {
    const gateway = createDemoGateway();
    const realWhoami = gateway.whoami.bind(gateway);
    let broken = true;
    gateway.whoami = () =>
      broken
        ? Promise.resolve({
            ok: false as const,
            error: { status: 503, code: "unavailable", message: "down" },
          })
        : realWhoami();
    const store = new CatalogStore();
    store.connect(gateway);
    await settle();
    expect(store.me).toBeUndefined();

    broken = false;
    store.refreshAll();
    await settle();
    expect(store.me).toBe("uday");
  });

  test("a stream reconnect is a reconcile point: ready refetches the world", async () => {
    const gateway = createDemoGateway();
    const statusListeners: Array<Parameters<DemoGateway["onConnectionStatus"]>[0]> = [];
    const original = gateway.onConnectionStatus.bind(gateway);
    gateway.onConnectionStatus = (listener) => {
      statusListeners.push(listener);
      return original(listener);
    };
    const { counts } = counted(gateway);
    const store = new CatalogStore();
    store.connect(gateway);
    await settle();
    await settle();
    const listsBefore = counts.listSpecs;

    const ready = await gateway.connection();
    statusListeners.forEach((listener) => listener(ready));
    await settle();
    expect(counts.listSpecs).toBe(listsBefore + 1);
  });
});

describe("CatalogStore event merging", () => {
  test("an event for one spec is one getSpec — never the world", async () => {
    const { gateway, counts, store } = await seeded();
    await gateway.updateSpec("chorus-billing-export", { status: "in_progress" });
    await settle();
    expect(counts.getSpec).toBe(1);
    expect(counts.listSpecs).toBe(1);
    expect(counts.listRooms).toBe(1);
    expect(store.specOf("chorus-billing-export")?.status).toBe("in_progress");
  });

  test("a burst of events for one spec coalesces its refetches", async () => {
    const { gateway, counts, store } = await seeded();
    store.noteEvent(event({ spec: "chorus-billing-export" }));
    store.noteEvent(event({ spec: "chorus-billing-export" }));
    store.noteEvent(event({ spec: "chorus-billing-export" }));
    await settle();
    expect(counts.getSpec).toBe(1);
    expect(counts.listSpecs).toBe(1);
    expect(gateway).toBeDefined();
  });

  test("a spec event for an unseen spec brings its room in with it", async () => {
    const { gateway, counts, store } = await seeded();
    await gateway.createSpec({
      id: "from-cli",
      project: "sail-mast",
      title: "Created by the CLI",
      status: "draft",
    });
    await settle();
    expect(counts.getSpec).toBe(1);
    expect(counts.getRoom).toBe(1);
    expect(counts.listRooms).toBe(1);
    expect(store.specOf("from-cli")?.title).toBe("Created by the CLI");
    expect(store.roomList()!.some((room) => room.id === "from-cli")).toBe(true);
  });

  test("a message event refreshes only the room it names", async () => {
    const { gateway, counts, store } = await seeded();
    await gateway.postSpecMessage("chorus-billing-export", { body: "ping", question: true });
    await settle();
    expect(counts.getRoom).toBe(1);
    expect(counts.getSpec).toBe(0);
    expect(counts.listSpecs).toBe(1);
    expect(store.roomList()!.some((room) => room.id === "chorus-billing-export")).toBe(true);
    expect(store.activityMap().get("chorus-billing-export")).toBeDefined();
  });

  test("board_updated is the one full-refresh trigger", async () => {
    const { counts, store } = await seeded();
    store.noteEvent(event({ type: "board_updated" }));
    await settle();
    expect(counts.listRooms).toBe(2);
    expect(counts.listSpecs).toBe(2);
  });

  test("an unknown record event naming a spec falls back to refetching that spec", async () => {
    const { counts, store } = await seeded();
    store.noteEvent(event({ type: "wormhole_opened", spec: "chorus-billing-export" }));
    await settle();
    expect(counts.getSpec).toBe(1);
    expect(counts.listSpecs).toBe(1);
  });

  test("foreign-owned and non-record events never refetch the catalog", async () => {
    const { counts, store } = await seeded();
    store.noteEvent(event({ type: "pty_session_started", spec: "design-talk" }));
    store.noteEvent(event({ type: "snapshot_created", spec: "chorus-billing-export" }));
    store.noteEvent(event({ type: "agent_tool_started", spec: "chorus-invoice-ui" }));
    store.noteEvent(event({ type: "heartbeat" }));
    await settle();
    expect(counts.getSpec).toBe(0);
    expect(counts.getRoom).toBe(0);
    expect(counts.listSpecs).toBe(1);
    expect(store.activityMap().get("design-talk")).toBe("2026-07-02T12:00:00Z");
  });

  test("a stale full list cannot undo a newer scoped event merge", async () => {
    const { gateway, store } = await seeded();
    const realList = gateway.listSpecs.bind(gateway);
    let releaseStale: (() => void) | undefined;
    let stalled = false;
    gateway.listSpecs = async (query) => {
      const result = await realList(query);
      if (!stalled) {
        stalled = true;
        await new Promise<void>((resolve) => {
          releaseStale = resolve;
        });
      }
      return result;
    };
    store.noteEvent(event({ type: "board_updated" }));
    await settle();

    await gateway.createSpec({
      id: "from-cli",
      project: "sail-mast",
      title: "Created mid-refresh",
      status: "draft",
    });
    await settle();
    expect(store.specOf("from-cli")).toBeDefined();

    releaseStale!();
    await settle();
    await settle();
    expect(store.specOf("from-cli")).toBeDefined();
  });

  test("a spec the backend no longer knows is removed, not kept as a ghost", async () => {
    const { gateway, store } = await seeded();
    gateway.getSpec = async () => ({
      ok: false,
      error: { status: 404, code: "spec_not_found", message: "gone" },
    });
    store.noteEvent(event({ spec: "chorus-billing-export" }));
    await settle();
    expect(store.specOf("chorus-billing-export")).toBeUndefined();
  });

  test("a stale scoped 404 cannot delete the row a newer scoped fetch installed", async () => {
    const { gateway, store } = await seeded();
    const realGetSpec = gateway.getSpec.bind(gateway);
    let release404: (() => void) | undefined;
    let calls = 0;
    gateway.getSpec = async (id) => {
      if (++calls > 1) return realGetSpec(id);
      await new Promise<void>((resolve) => {
        release404 = resolve;
      });
      return {
        ok: false as const,
        error: { status: 404, code: "spec_not_found", message: "gone" },
      };
    };
    const stale = store.refreshSpec("chorus-billing-export");
    await store.refreshSpec("chorus-billing-export");
    expect(store.specOf("chorus-billing-export")).toBeDefined();

    release404!();
    await stale;
    expect(store.specOf("chorus-billing-export")).toBeDefined();
  });

  test("a stale scoped 404 cannot delete the row a mutation ack upserted", async () => {
    const { gateway, store } = await seededQuiet();
    let release404: (() => void) | undefined;
    gateway.getSpec = async () =>
      new Promise((resolve) => {
        release404 = () =>
          resolve({
            ok: false,
            error: { status: 404, code: "spec_not_found", message: "gone" },
          });
      });
    const stale = store.refreshSpec("chorus-billing-export");
    await store.updateSpec("chorus-billing-export", { status: "in_progress" });
    expect(store.specOf("chorus-billing-export")?.status).toBe("in_progress");

    release404!();
    await stale;
    expect(store.specOf("chorus-billing-export")?.status).toBe("in_progress");
  });

  test("a 404 for a row the store never held still beats the in-flight seed", async () => {
    const gateway = createDemoGateway();
    const realList = gateway.listSpecs.bind(gateway);
    const realGetSpec = gateway.getSpec.bind(gateway);
    let releaseSeed: (() => void) | undefined;
    let listings = 0;
    gateway.listSpecs = async (query) => {
      const result = await realList(query);
      if (++listings === 1) {
        await new Promise<void>((resolve) => {
          releaseSeed = resolve;
        });
        return result;
      }
      if (!result.ok) return result;
      const specs = result.value.specs.filter((spec) => spec.id !== "chorus-billing-export");
      return { ...result, value: { specs, total: specs.length } };
    };
    gateway.getSpec = (id) =>
      id === "chorus-billing-export"
        ? Promise.resolve({
            ok: false as const,
            error: { status: 404, code: "spec_not_found", message: "gone" },
          })
        : realGetSpec(id);
    const store = new CatalogStore();
    store.connect(gateway);
    await Promise.resolve();
    await store.refreshSpec("chorus-billing-export");
    expect(store.specOf("chorus-billing-export")).toBeUndefined();

    releaseSeed!();
    await settle();
    await settle();
    expect(store.seeded).toBe(true);
    expect(store.specOf("chorus-billing-export")).toBeUndefined();
    expect(store.specList().length).toBe(10);
  });
});

describe("CatalogStore runs slice", () => {
  test("retaining a spec's runs fetches once and refreshes on its run events only", async () => {
    const { counts, store } = await seeded();
    const release = store.retainRuns("chorus-invoice-ui");
    await settle();
    expect(counts.listRuns).toBe(1);
    expect(store.runsOf("chorus-invoice-ui")?.some((run) => run.status === "running")).toBe(true);

    store.noteEvent(event({ type: "agent_session_started", spec: "chorus-invoice-ui" }));
    await settle();
    expect(counts.listRuns).toBe(2);

    store.noteEvent(event({ type: "agent_session_started", spec: "chorus-rate-limits" }));
    await settle();
    expect(counts.listRuns).toBe(2);

    release();
    store.noteEvent(event({ type: "agent_session_started", spec: "chorus-invoice-ui" }));
    await settle();
    expect(counts.listRuns).toBe(2);
  });

  test("a failed runs listing stays null (fail closed) and retries at the next reconcile", async () => {
    const { gateway, store } = await seeded();
    const real = gateway.listRuns.bind(gateway);
    let broken = true;
    gateway.listRuns = (specId) =>
      broken
        ? Promise.resolve({
            ok: false as const,
            error: { status: 503, code: "unavailable", message: "down" },
          })
        : real(specId);
    store.retainRuns("chorus-invoice-ui");
    await settle();
    expect(store.runsOf("chorus-invoice-ui")).toBeNull();

    broken = false;
    store.refreshAll();
    await settle();
    expect(store.runsOf("chorus-invoice-ui")).not.toBeNull();
  });

  test("a failing refresh invalidates the retained list — stale runs are never evidence", async () => {
    const { gateway, store } = await seeded();
    store.retainRuns("chorus-invoice-ui");
    await settle();
    expect(store.runsOf("chorus-invoice-ui")).not.toBeNull();

    gateway.listRuns = () =>
      Promise.resolve({
        ok: false as const,
        error: { status: 503, code: "unavailable", message: "down" },
      });
    store.noteEvent(event({ type: "agent_session_started", spec: "chorus-invoice-ui" }));
    await settle();
    expect(store.runsOf("chorus-invoice-ui")).toBeNull();
  });

  test("re-retaining a released slice never trusts cached absence", async () => {
    const { gateway, store } = await seeded();
    let runs: RunView[] = [];
    gateway.listRuns = async () => ({ ok: true as const, value: { runs } });
    const release = store.retainRuns("chorus-billing-export");
    await settle();
    expect(store.runsOf("chorus-billing-export")).toEqual([]);
    release();
    expect(store.runsOf("chorus-billing-export")).toBeNull();

    runs = [demoRun("chorus-billing-export", "running")];
    store.retainRuns("chorus-billing-export");
    expect(store.runsOf("chorus-billing-export")).toBeNull();
    await settle();
    expect(store.runsOf("chorus-billing-export")?.map((run) => run.status)).toEqual(["running"]);
  });

  test("a listing that started before release cannot repopulate the cache", async () => {
    const { gateway, store } = await seeded();
    const pending: Array<(runs: RunView[]) => void> = [];
    gateway.listRuns = () =>
      new Promise((resolve) => {
        pending.push((runs) => resolve({ ok: true, value: { runs } }));
      });
    const release = store.retainRuns("chorus-billing-export");
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.length).toBe(1);

    release();
    store.retainRuns("chorus-billing-export");
    pending.shift()!([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.runsOf("chorus-billing-export")).toBeNull();

    await settle();
    pending.shift()!([demoRun("chorus-billing-export", "running")]);
    await settle();
    expect(store.runsOf("chorus-billing-export")?.map((run) => run.status)).toEqual(["running"]);
  });

  test("a run event without a spec conservatively refreshes every held list", async () => {
    const { counts, store } = await seeded();
    store.retainRuns("chorus-invoice-ui");
    await settle();
    expect(counts.listRuns).toBe(1);
    store.noteEvent(event({ type: "agent_session_stopped", spec: undefined }));
    await settle();
    expect(counts.listRuns).toBe(2);
  });
});

describe("CatalogStore mutations", () => {
  test("a lane move lands the ack's row without refetching the world", async () => {
    const { counts, store } = await seeded();
    const result = await store.moveSpec("chorus-billing-export", "in_progress");
    await settle();
    expect(result.outcome).toBe("ok");
    expect(store.specOf("chorus-billing-export")?.status).toBe("in_progress");
    expect(counts.listSpecs).toBe(1);
  });

  test("a concurrent writer is a conflict and a scoped refetch, never an overwrite", async () => {
    const { gateway, counts, store } = await seeded();
    await gateway.updateSpec("chorus-billing-export", { title: "changed elsewhere" });
    await settle();
    const getsBefore = counts.getSpec;
    const result = await store.moveSpec("chorus-billing-export", "in_progress");
    await settle();
    expect(result.outcome).toBe("conflict");
    expect(counts.getSpec).toBeGreaterThan(getsBefore);
    expect(store.specOf("chorus-billing-export")?.title).toBe("changed elsewhere");
    expect(counts.listSpecs).toBe(1);
  });

  test("a failed move surfaces the backend error for the surface to render", async () => {
    const { gateway, store } = await seeded();
    gateway.updateSpec = async () => ({
      ok: false,
      error: { status: 422, code: "invalid_transition", message: "no" },
    });
    const result = await store.moveSpec("chorus-billing-export", "in_progress");
    expect(result.outcome).toBe("error");
    expect(result.error?.message).toBe("no");
  });

  test("createRoom retries past a creation race and reports engage failures loud", async () => {
    const { gateway, store } = await seeded();
    const createRoom = gateway.createRoom.bind(gateway);
    let raced = false;
    gateway.createRoom = async (request) => {
      if (!raced && request.id === "passkey-auth") {
        raced = true;
        await createRoom(request);
      }
      return createRoom(request);
    };
    const result = await store.createRoom("Passkey auth", "chorus");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe("passkey-auth-2");
    expect(store.roomList()!.some((room) => room.id === "passkey-auth-2")).toBe(true);

    gateway.engage = async () => ({
      ok: false,
      error: { status: 400, code: "bad_request", message: "no such agent" },
    });
    const failed = await store.createRoom("Lonely room", "chorus", "hal9000");
    expect(failed.ok).toBe(true);
    expect(failed.ok && failed.engageError).toBe("no such agent");
  });

  test("dispatch reconciles the named spec and held runs on the ack — event lane dead", async () => {
    const { counts, store } = await seededQuiet();
    store.retainRuns("chorus-billing-export");
    await settle();
    const runsBefore = counts.listRuns;
    const result = await store.dispatch("chorus", {
      spec_id: "chorus-billing-export",
      mode: "background",
    });
    await settle();
    expect(result.ok).toBe(true);
    expect(store.specOf("chorus-billing-export")?.status).toBe("in_progress");
    expect(counts.listRuns).toBeGreaterThan(runsBefore);
    expect(counts.listSpecs).toBe(1);
  });

  test("engage and disengage reconcile the room and its spec — event lane dead", async () => {
    const { counts, store } = await seededQuiet();
    const result = await store.engage("chorus-billing-export", { agent: "claude-code" });
    await settle();
    expect(result.ok).toBe(true);
    expect(store.specOf("chorus-billing-export")?.engagement?.agent).toBe("claude-code");
    expect(
      store
        .roomList()!
        .find((room) => room.id === "chorus-billing-export")
        ?.members.map((member) => member.agent),
    ).toEqual(["claude-code"]);

    const dismissed = await store.disengage("chorus-billing-export");
    await settle();
    expect(dismissed.ok).toBe(true);
    expect(store.specOf("chorus-billing-export")?.engagement).toBeUndefined();
    expect(counts.listSpecs).toBe(1);
    expect(counts.listRooms).toBe(1);
  });

  test("stopRun reconciles the spec's row on the ack — event lane dead", async () => {
    const { store } = await seededQuiet();
    const result = await store.stopRun("demo-run-chorus-invoice-ui-build", "chorus-invoice-ui");
    await settle();
    expect(result.ok).toBe(true);
    expect(store.specOf("chorus-invoice-ui")?.status).toBe("cancelled");
  });
});

/**
 * The logout boundary: App reuses one Gateway object across sign-out/sign-in,
 * so gateway identity cannot fence off the previous account's in-flight
 * requests — only the reset epoch can. A request begun under account A must
 * never land in account B's store.
 */
describe("CatalogStore reset epoch", () => {
  test("a spec fetch begun before reset cannot leak into the next sign-in", async () => {
    const { gateway, store } = await seeded();
    const realGetSpec = gateway.getSpec.bind(gateway);
    let releaseStale: (() => void) | undefined;
    gateway.getSpec = async (id) => {
      const result = await realGetSpec(id);
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return result;
    };
    const stale = store.refreshSpec("chorus-billing-export");

    store.reset();
    gateway.getSpec = realGetSpec;
    gateway.listSpecs = async () => ({ ok: true as const, value: { specs: [], total: 0 } });
    store.connect(gateway);
    await settle();
    expect(store.specList()).toEqual([]);

    releaseStale!();
    await stale;
    await settle();
    expect(store.specOf("chorus-billing-export")).toBeUndefined();
    expect(store.specList()).toEqual([]);
  });

  test("a room creation begun before reset cannot engage an agent in the next sign-in", async () => {
    const { gateway, store } = await seeded();
    const template = store.roomList()![0];
    let releaseStale: (() => void) | undefined;
    gateway.createRoom = async (request) =>
      new Promise((resolve) => {
        releaseStale = () => resolve({ ok: true, value: { ...template, ...request } });
      });
    let engages = 0;
    const realEngage = gateway.engage.bind(gateway);
    gateway.engage = (roomId, request) => {
      engages++;
      return realEngage(roomId, request);
    };
    const stale = store.createRoom("Ghost room", "chorus", "claude-code");

    store.reset();
    store.connect(gateway);
    await settle();

    releaseStale!();
    const result = await stale;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("session_changed");
    expect(engages).toBe(0);
    expect(store.roomList()!.some((room) => room.id === "ghost-room")).toBe(false);
  });

  test("a stale 409 cannot trigger another creation attempt in the next sign-in", async () => {
    const { gateway, store } = await seeded();
    let creates = 0;
    let releaseStale: (() => void) | undefined;
    gateway.createRoom = async () => {
      creates++;
      return new Promise((resolve) => {
        releaseStale = () =>
          resolve({ ok: false, error: { status: 409, code: "conflict", message: "exists" } });
      });
    };
    const stale = store.createRoom("Ghost room", "chorus");

    store.reset();
    store.connect(gateway);
    await settle();

    releaseStale!();
    const result = await stale;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("session_changed");
    expect(creates).toBe(1);
  });

  test("a whoami begun before reset cannot overwrite the next account's identity", async () => {
    const { gateway, store } = await seeded();
    const realWhoami = gateway.whoami.bind(gateway);
    let releaseStale: (() => void) | undefined;
    gateway.whoami = async () => {
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return realWhoami();
    };
    store.refreshAll();
    await Promise.resolve();

    store.reset();
    gateway.whoami = async () => {
      const result = await realWhoami();
      return result.ok ? { ...result, value: { ...result.value, fde: "new-user" } } : result;
    };
    store.connect(gateway);
    await settle();
    expect(store.me).toBe("new-user");

    releaseStale!();
    await settle();
    expect(store.me).toBe("new-user");
  });
});
