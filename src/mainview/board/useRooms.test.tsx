import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDemoGateway, type DemoGateway } from "../gateway";
import { sectionRooms, type StorageLike } from "./rooms";
import { useRooms } from "./useRooms";

let root: Root;
let container: HTMLElement;

type Handle = ReturnType<typeof useRooms>;

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function Harness({
  gateway,
  storage,
  capture,
}: {
  gateway: DemoGateway;
  storage: StorageLike;
  capture: (handle: Handle) => void;
}) {
  const handle = useRooms(gateway, storage);
  capture(handle);
  return <div data-count={handle.data.rooms.length} />;
}

async function render() {
  const gateway = createDemoGateway();
  const storage = memoryStorage();
  let latest: Handle | undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <Harness
        gateway={gateway}
        storage={storage}
        capture={(handle) => {
          latest = handle;
        }}
      />,
    );
  });
  await act(async () => {});
  await act(async () => {});
  return { gateway, handle: () => latest! };
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useRooms", () => {
  test("the personal room pins first from the one listing, with no refetch to show it", async () => {
    const { gateway, handle } = await render();
    let listings = 0;
    const listRooms = gateway.listRooms.bind(gateway);
    gateway.listRooms = (project?: string) => {
      listings++;
      return listRooms(project);
    };

    expect(handle().data.me).toBe("uday");
    const sections = sectionRooms(
      handle().data.rooms.filter((room) => room.room.project === "sail-mast"),
      handle().data.me,
    );
    expect(sections[0]?.section).toBe("personal");
    expect(sections[0]?.rooms.map((room) => room.room.id)).toEqual(["fde-uday-sail-mast"]);
    expect(listings).toBe(0);
  });

  test("loads every project, marks a visit read, and reacts to an unfocused message", async () => {
    const { gateway, handle } = await render();
    expect(handle().data.projects).toEqual(["chorus", "nautilus", "sail-mast"]);
    expect(handle().data.rooms.length).toBeGreaterThan(7);

    const opened = handle().data.rooms.find((room) => room.room.id === "chorus-auth-flow")!;
    act(() => handle().open(opened));
    expect(handle().data.rooms.find((room) => room.room.id === opened.room.id)?.unread).toBe(false);

    await act(async () => {
      await gateway.postSpecMessage("chorus-billing-export", { body: "Needs your attention" });
    });
    await act(async () => {});
    await act(async () => {});

    const incoming = handle().data.rooms.find(
      (room) => room.room.id === "chorus-billing-export",
    );
    expect(incoming?.unread).toBe(true);
    expect(handle().data.rooms[0]?.room.id).toBe("chorus-billing-export");
  });

  test("paints rooms from the spec list even when recent events never arrive", async () => {
    const gateway = createDemoGateway();
    const hanging = Object.create(gateway) as DemoGateway;
    hanging.recentEvents = () => new Promise(() => {});
    const storage = memoryStorage();
    let latest: Handle | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <Harness
          gateway={hanging}
          storage={storage}
          capture={(handle) => {
            latest = handle;
          }}
        />,
      );
    });
    await act(async () => {});
    await act(async () => {});

    expect(latest!.data.loading).toBe(false);
    expect(latest!.data.rooms.length).toBeGreaterThan(0);
  });

  test("creates a chat room and refreshes it into the room list", async () => {
    const { gateway, handle } = await render();

    let result: Awaited<ReturnType<Handle["create"]>> | undefined;
    await act(async () => {
      result = await handle().create("Passkey auth flow", "chorus");
    });
    await act(async () => {});

    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.id).toBe("passkey-auth-flow");
    expect(result.value.spec_ids).toEqual([]);
    const created = handle().data.rooms.find((room) => room.room.id === "passkey-auth-flow");
    expect(created).toBeDefined();
    expect(created?.spec).toBeUndefined();

    const listed = await gateway.listRooms("chorus");
    expect(listed.ok && listed.value.rooms.some((room) => room.id === "passkey-auth-flow")).toBe(
      true,
    );
  });

  test("creating with an agent engages the room and reports an engage failure honestly", async () => {
    const { gateway, handle } = await render();

    let result: Awaited<ReturnType<Handle["create"]>> | undefined;
    await act(async () => {
      result = await handle().create("Chat room", "chorus", "claude-code");
    });
    await act(async () => {});
    expect(result?.ok).toBe(true);
    const created = await gateway.getRoom("chat-room");
    expect(created.ok && created.value.members[0]?.agent).toBe("claude-code");
    expect(created.ok && created.value.members[0]?.mode).toBe("full");

    const engage = gateway.engage;
    gateway.engage = async () => ({
      ok: false,
      error: { status: 400, code: "bad_request", message: "no such agent" },
    });
    let failed: Awaited<ReturnType<Handle["create"]>> | undefined;
    await act(async () => {
      failed = await handle().create("Lonely room", "chorus", "hal9000");
    });
    await act(async () => {});
    gateway.engage = engage;
    expect(failed?.ok).toBe(true);
    expect(failed && "engageError" in failed ? failed.engageError : undefined).toBe(
      "no such agent",
    );
  });

  test("retries with a suffixed id when another creator wins the race", async () => {
    const { gateway, handle } = await render();
    const createRoom = gateway.createRoom;
    let raced = false;
    gateway.createRoom = async (request) => {
      if (!raced && request.id === "passkey-auth") {
        raced = true;
        await createRoom(request);
      }
      return createRoom(request);
    };

    let result: Awaited<ReturnType<Handle["create"]>> | undefined;
    await act(async () => {
      result = await handle().create("Passkey auth", "chorus");
    });
    await act(async () => {});

    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.id).toBe("passkey-auth-2");
  });

  test("an externally created spec arrives through SSE without polling", async () => {
    const { gateway, handle } = await render();

    await act(async () => {
      await gateway.createSpec({
        id: "from-cli",
        project: "sail-mast",
        title: "Created by the CLI",
        status: "draft",
      });
    });
    await act(async () => {});
    await act(async () => {});

    expect(handle().data.rooms.some((room) => room.room.id === "from-cli")).toBe(true);
  });
});
