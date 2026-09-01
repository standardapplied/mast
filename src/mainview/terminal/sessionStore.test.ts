import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import type { DeckSession } from "./roomDeck";
import { boxKeyOf, connectSessions, SessionStore } from "./sessionStore";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function session(over: Partial<DeckSession>): DeckSession {
  return {
    name: "room-design-talk",
    live: true,
    attached: 1,
    writerFde: "uday",
    room: "design-talk",
    command: ["bash", "-l"],
    ...over,
  };
}

function ptyEvent(over: Partial<SailEvent>): SailEvent {
  return {
    v: 1,
    ts: "2026-09-01T12:00:00Z",
    project: "sail-mast",
    spec: "design-talk",
    type: "pty_session_started",
    agent: "uday",
    host: "devbox",
    ...over,
  } as SailEvent;
}

function makeGateway(host: DeckSession[]) {
  const calls = { list: 0, kill: [] as string[], getRoom: [] as string[] };
  let listFailure: string | null = null;
  let roomFailure: string | null = null;
  let roomEcho: string | null = null;
  const listeners = new Set<(e: SailEvent) => void>();
  const gateway = {
    connection: async () => ({ server: "ssh://devbox", phase: "ready" }),
    listSessions: async () => {
      calls.list++;
      if (listFailure) {
        return {
          ok: false as const,
          error: { status: 0, code: "pty_unreachable", message: listFailure },
        };
      }
      return { ok: true as const, value: [...host] };
    },
    killSession: async (name: string) => {
      calls.kill.push(name);
      const index = host.findIndex((s) => s.name === name);
      if (index < 0) {
        return {
          ok: false as const,
          error: { status: 0, code: "pty_unreachable", message: `no session '${name}'` },
        };
      }
      host.splice(index, 1);
      return { ok: true as const, value: { session: name } };
    },
    getRoom: async (id: string) => {
      calls.getRoom.push(id);
      if (roomFailure) {
        return {
          ok: false as const,
          error: { status: 404, code: "room_not_found", message: roomFailure },
        };
      }
      return {
        ok: true as const,
        value: {
          id: roomEcho ?? id,
          project: "sail-mast",
          title: id,
          members: [],
          spec_ids: [],
          created_at: "",
          updated_at: "",
        },
      };
    },
    specEvents: async (id: string) => ({
      ok: true as const,
      value: { spec: id, limit: 100, returned: 0, events: [] as SailEvent[] },
    }),
    onEvent: (l: (e: SailEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onConnectionStatus: () => () => {},
  };
  return {
    gateway: gateway as unknown as Gateway,
    host,
    calls,
    failListings: (message: string | null) => (listFailure = message),
    failRooms: (message: string | null) => (roomFailure = message),
    echoRoom: (id: string) => (roomEcho = id),
    emit: (e: SailEvent) => listeners.forEach((l) => l(e)),
    setSpecEvents: (events: SailEvent[]) => {
      gateway.specEvents = async (id: string) => ({
        ok: true as const,
        value: { spec: id, limit: 100, returned: events.length, events },
      });
    },
  };
}

async function connected(host: DeckSession[] = []) {
  const fake = makeGateway(host);
  const store = new SessionStore();
  store.connect(fake.gateway, "devbox");
  await flush();
  return { ...fake, store };
}

describe("listing ownership", () => {
  test("sessions are null until the first listing, then the box's truth", async () => {
    const store = new SessionStore();
    expect(store.sessions()).toBeNull();
    const { store: s } = await connected([session({})]);
    expect(s.sessions()?.map((x) => x.name)).toEqual(["room-design-talk"]);
  });

  test("a failed listing keeps the last good value and surfaces the skew reason", async () => {
    const box = await connected([session({})]);
    box.failListings("pty protocol skew: the box speaks SAILPTY1");
    box.store.refresh();
    await flush();
    expect(box.store.sessions()?.length).toBe(1);
    expect(box.store.skewReason()).toContain("SAILPTY1");
    box.failListings(null);
    box.store.refresh();
    await flush();
    expect(box.store.skewReason()).toBeNull();
  });

  test("refresh bursts coalesce into few listings", async () => {
    const box = await connected([]);
    const before = box.calls.list;
    for (let i = 0; i < 20; i++) box.store.refresh();
    await flush();
    expect(box.calls.list - before).toBeLessThanOrEqual(2);
  });
});

describe("death records", () => {
  test("a listing that drops a previously-live name records its death with the command", async () => {
    const box = await connected([session({ command: ["claude"] })]);
    box.host.length = 0;
    box.store.refresh();
    await flush();
    expect(box.store.sessions()).toEqual([]);
    const death = box.store.deaths().get("room-design-talk");
    expect(death?.command).toEqual(["claude"]);
    expect(death?.reason).toBe("ended");
  });

  test("a name listed live again is alive — its death record clears (external recreate)", async () => {
    const box = await connected([session({})]);
    box.host.length = 0;
    box.store.refresh();
    await flush();
    expect(box.store.deaths().has("room-design-talk")).toBe(true);
    box.host.push(session({}));
    box.store.refresh();
    await flush();
    expect(box.store.deaths().has("room-design-talk")).toBe(false);
  });

  test("a live-to-dead listing transition records the death, and the record survives the corpse being dropped", async () => {
    const box = await connected([session({ command: ["claude"] })]);
    box.host.splice(0, 1, session({ live: false, command: ["claude"] }));
    box.store.refresh();
    await flush();
    expect(box.store.deaths().get("room-design-talk")?.reason).toBe("ended");
    box.host.length = 0;
    box.store.refresh();
    await flush();
    expect(
      box.store.deaths().get("room-design-talk")?.command,
      "the drop must read as a known death, never a host-restart loss that recreates a shell",
    ).toEqual(["claude"]);
  });

  test("a first-load corpse is recorded; history backfill upgrades its generic reason", async () => {
    const fake = makeGateway([session({ name: "resume-run-7", live: false, command: ["codex"] })]);
    fake.setSpecEvents([
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "resume-run-7", reason: "yielded to dispatch r8 of spec s1" },
      }),
    ]);
    const store = new SessionStore();
    store.connect(fake.gateway, "devbox");
    await flush();
    expect(store.deaths().get("resume-run-7")?.reason).toBe("ended");
    store.ensureHistory("design-talk");
    await flush();
    expect(store.deaths().get("resume-run-7")?.reason).toBe("yielded to dispatch r8 of spec s1");
    expect(store.reasons()["resume-run-7"]).toBe("yielded to dispatch r8 of spec s1");
  });

  test("a pty_session_ended event records the server's reason, dims the entry, and outranks the generic drop", async () => {
    const box = await connected([session({})]);
    box.store.noteEvent(
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "room-design-talk", reason: "exited(0)" },
      }),
    );
    expect(box.store.byName("room-design-talk")?.live).toBe(false);
    expect(box.store.deaths().get("room-design-talk")?.reason).toBe("exited(0)");
    expect(box.store.reasons()["room-design-talk"]).toBe("exited(0)");
  });

  test("history asked for before the box connects is remembered and drained on connect", async () => {
    const store = new SessionStore();
    store.ensureHistory("design-talk");
    const fake = makeGateway([]);
    fake.setSpecEvents([
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "resume-run-7", reason: "exited(0)" },
      }),
    ]);
    store.connect(fake.gateway, "devbox");
    await flush();
    expect(store.reasons()["resume-run-7"]).toBe("exited(0)");
  });

  test("history backfill supplies reasons for deaths observed before this instance; death records win", async () => {
    const box = await connected([]);
    box.setSpecEvents([
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "resume-run-7", reason: "yielded to dispatch r8" },
      }),
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "room-design-talk", reason: "exited(1)" },
      }),
    ]);
    box.store.ensureHistory("design-talk");
    await flush();
    expect(box.store.reasons()["resume-run-7"]).toBe("yielded to dispatch r8");
    box.store.noteEvent(
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "room-design-talk", reason: "exited(0)" },
      }),
    );
    expect(box.store.reasons()["room-design-talk"]).toBe("exited(0)");
  });
});

describe("creates", () => {
  test("a launch intent shows in every read immediately and clears the name's tombstone", async () => {
    const box = await connected([session({})]);
    box.host.length = 0;
    box.store.refresh();
    await flush();
    expect(box.store.deaths().has("room-design-talk")).toBe(true);

    box.store.noteLaunch("room-design-talk", ["claude"], "design-talk");
    expect(box.store.deaths().has("room-design-talk")).toBe(false);
    const entry = box.store.byName("room-design-talk");
    expect(entry?.pending).toBe(true);
    expect(entry?.command).toEqual(["claude"]);
  });

  test("a pending create the box confirms becomes the listing's entry", async () => {
    const box = await connected([]);
    box.store.noteLaunch("room-design-talk.2", ["codex"], "design-talk");
    box.host.push(session({ name: "room-design-talk.2", command: ["codex"], attached: 1 }));
    box.store.refresh();
    await flush();
    const entry = box.store.byName("room-design-talk.2");
    expect(entry?.pending).toBeUndefined();
    expect(entry?.attached).toBe(1);
  });

  test("a create the box never confirms stops haunting the deck after two listings", async () => {
    const box = await connected([]);
    box.store.noteLaunch("room-design-talk.2", ["codex"], "design-talk");
    box.store.refresh();
    await flush();
    expect(box.store.byName("room-design-talk.2")).toBeDefined();
    box.store.refresh();
    await flush();
    expect(box.store.byName("room-design-talk.2")).toBeUndefined();
  });

  test("a pty_session_started event seeds the entry before any listing confirms it", async () => {
    const box = await connected([]);
    box.store.noteEvent(
      ptyEvent({
        data: { session: "room-design-talk", room_id: "design-talk", executable: "claude" },
      }),
    );
    const entry = box.store.byName("room-design-talk");
    expect(entry?.room).toBe("design-talk");
    expect(entry?.command).toEqual(["claude"]);
  });
});

describe("the kill path (field bug: a kill that does nothing, silently)", () => {
  test("a room the control plane can't resolve refuses the kill INLINE — the session is left alone", async () => {
    const box = await connected([session({})]);
    box.failRooms("no room 'design-talk'");
    const result = await box.store.kill("room-design-talk");
    expect(result.ok).toBe(false);
    expect(box.calls.kill).toEqual([]);
    const entry = box.store.byName("room-design-talk");
    expect(entry?.live).toBe(true);
    expect(entry?.refusal).toContain("no room 'design-talk'");
    expect(entry?.dying).toBeUndefined();
  });

  test("a room resolving to a different id refuses the same way", async () => {
    const box = await connected([session({})]);
    box.echoRoom("someone-else");
    await box.store.kill("room-design-talk");
    expect(box.calls.kill).toEqual([]);
    expect(box.store.byName("room-design-talk")?.refusal).toContain("unresolved");
  });

  test("a caller inside the room skips the guard — pty-only degraded links still close panes", async () => {
    const box = await connected([session({})]);
    box.failRooms("control plane down");
    const result = await box.store.kill("room-design-talk", { resolvedRoom: "design-talk" });
    expect(result.ok).toBe(true);
    expect(box.calls.getRoom).toEqual([]);
    expect(box.calls.kill).toEqual(["room-design-talk"]);
  });

  test("an ack converges every selector at once: entry gone, death recorded, re-list taken", async () => {
    const box = await connected([session({ command: ["claude"] })]);
    const listings = box.calls.list;
    const result = await box.store.kill("room-design-talk", { resolvedRoom: "design-talk" });
    expect(result.ok).toBe(true);
    expect(box.store.byName("room-design-talk")).toBeUndefined();
    const death = box.store.deaths().get("room-design-talk");
    expect(death?.reason).toBe("closed from Mast");
    expect(death?.command).toEqual(["claude"]);
    await flush();
    expect(box.calls.list).toBeGreaterThan(listings);
  });

  test("a box refusal lands inline on the entry and clears the dying mark — never swallowed", async () => {
    const box = await connected([session({ name: "ghost", room: "" })]);
    box.host.length = 0;
    box.host.push(session({ name: "other", room: "" }));
    const result = await box.store.kill("ghost");
    expect(result.ok).toBe(false);
    expect(box.store.byName("ghost")?.refusal).toContain("no session 'ghost'");
    expect(box.store.byName("ghost")?.dying).toBeUndefined();
  });

  test("a later successful kill clears the old refusal", async () => {
    const box = await connected([session({})]);
    box.failRooms("blip");
    await box.store.kill("room-design-talk");
    expect(box.store.byName("room-design-talk")?.refusal).toBeDefined();
    box.failRooms(null);
    const result = await box.store.kill("room-design-talk");
    expect(result.ok).toBe(true);
    expect(box.store.byName("room-design-talk")).toBeUndefined();
  });
});

describe("box keying", () => {
  test("state lives under the box key; a second box never sees the first's inventory", async () => {
    const store = new SessionStore();
    const a = makeGateway([session({})]);
    store.connect(a.gateway, "box-a");
    await flush();
    expect(store.sessions("box-a")?.length).toBe(1);

    const b = makeGateway([]);
    store.connect(b.gateway, "box-b");
    await flush();
    expect(store.sessions()).toEqual([]);
    expect(store.sessions("box-a")?.length).toBe(1);
  });

  test("reconnecting the same box keeps its death records", async () => {
    const host = [session({})];
    const store = new SessionStore();
    const first = makeGateway(host);
    const disconnect = store.connect(first.gateway, "devbox");
    await flush();
    host.length = 0;
    store.refresh();
    await flush();
    expect(store.deaths().has("room-design-talk")).toBe(true);

    disconnect();
    const second = makeGateway(host);
    store.connect(second.gateway, "devbox");
    await flush();
    expect(store.deaths().has("room-design-talk")).toBe(true);
  });
});

describe("connectSessions", () => {
  test("derives the box key from the connection target and takes the first listing", async () => {
    const fake = makeGateway([session({})]);
    const store = new SessionStore();
    const off = connectSessions(fake.gateway, store);
    await flush();
    expect(boxKeyOf({ server: "ssh://devbox" })).toBe("ssh://devbox");
    expect(store.sessions("ssh://devbox")?.length).toBe(1);
    off();
  });

  test("a pty event accelerates: it folds in and kicks a re-list", async () => {
    const fake = makeGateway([]);
    const store = new SessionStore();
    const off = connectSessions(fake.gateway, store);
    await flush();
    const listings = fake.calls.list;
    fake.emit(
      ptyEvent({
        type: "pty_session_ended",
        data: { session: "room-design-talk", reason: "exited(0)" },
      }),
    );
    await flush();
    expect(store.reasons()["room-design-talk"]).toBe("exited(0)");
    expect(fake.calls.list).toBeGreaterThan(listings);
    off();
  });
});
