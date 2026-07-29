import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDemoGateway, type DemoGateway } from "../gateway";
import type { StorageLike } from "./rooms";
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
  test("loads every project, marks a visit read, and reacts to an unfocused message", async () => {
    const { gateway, handle } = await render();
    expect(handle().data.projects).toEqual(["chorus", "nautilus", "sail-mast"]);
    expect(handle().data.rooms.length).toBeGreaterThan(7);

    const opened = handle().data.rooms.find((room) => room.spec.id === "chorus-auth-flow")!;
    act(() => handle().open(opened));
    expect(handle().data.rooms.find((room) => room.spec.id === opened.spec.id)?.unread).toBe(false);

    await act(async () => {
      await gateway.postSpecMessage("chorus-billing-export", { body: "Needs your attention" });
    });
    await act(async () => {});
    await act(async () => {});

    const incoming = handle().data.rooms.find(
      (room) => room.spec.id === "chorus-billing-export",
    );
    expect(incoming?.unread).toBe(true);
    expect(handle().data.rooms[0]?.spec.id).toBe("chorus-billing-export");
  });

  test("creates a collision-safe draft and refreshes it into the room list", async () => {
    const { gateway, handle } = await render();

    let result: Awaited<ReturnType<Handle["create"]>> | undefined;
    await act(async () => {
      result = await handle().create("Passkey auth flow", "chorus");
    });
    await act(async () => {});

    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.spec.id).toBe("passkey-auth-flow");
    expect(result.value.spec.status).toBe("draft");
    expect(handle().data.rooms.some((room) => room.spec.id === "passkey-auth-flow")).toBe(true);

    const listed = await gateway.listSpecs({ project: "chorus" });
    expect(listed.ok && listed.value.specs.some((spec) => spec.id === "passkey-auth-flow")).toBe(
      true,
    );
  });

  test("retries with a suffixed id when another creator wins the race", async () => {
    const { gateway, handle } = await render();
    const createSpec = gateway.createSpec;
    let raced = false;
    gateway.createSpec = async (request) => {
      if (!raced && request.id === "passkey-auth") {
        raced = true;
        await createSpec(request);
      }
      return createSpec(request);
    };

    let result: Awaited<ReturnType<Handle["create"]>> | undefined;
    await act(async () => {
      result = await handle().create("Passkey auth", "chorus");
    });
    await act(async () => {});

    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.spec.id).toBe("passkey-auth-2");
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

    expect(handle().data.rooms.some((room) => room.spec.id === "from-cli")).toBe(true);
  });
});
