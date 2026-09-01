import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
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
