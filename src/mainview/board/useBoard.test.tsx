import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDemoGateway, type DemoGateway } from "../gateway";
import { canTransition } from "./lifecycle";
import { useBoard, type MoveOutcome } from "./useBoard";

let root: Root;
let container: HTMLElement;

type Handle = ReturnType<typeof useBoard>;

function Harness({
  gateway,
  project = "chorus",
  capture,
}: {
  gateway: DemoGateway;
  project?: string;
  capture: (h: Handle) => void;
}) {
  const handle = useBoard(gateway, project, {});
  capture(handle);
  return <div data-count={handle.data.specs.length} />;
}

async function render(gateway: DemoGateway) {
  let latest: Handle | null = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const rerender = (project: string) =>
    act(() =>
      root.render(<Harness gateway={gateway} project={project} capture={(h) => (latest = h)} />),
    );
  act(() => root.render(<Harness gateway={gateway} capture={(h) => (latest = h)} />));
  await act(async () => {});
  return { handle: () => latest!, rerender };
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useBoard", () => {
  test("loads specs, summary, and the derived project list", async () => {
    const { handle } = await render(createDemoGateway());
    expect(handle().data.specs.length).toBe(7);
    expect(handle().data.summary?.in_progress).toBe(1);
    expect(handle().data.projects).toEqual(["chorus", "sail-mast"]);
  });

  test("switching project shows loading, then the new scope; SSE refetches stay silent", async () => {
    const gateway = createDemoGateway();
    const { handle, rerender } = await render(gateway);
    expect(handle().data.loading).toBe(false);

    rerender("sail-mast");
    expect(handle().data.loading).toBe(true);

    await act(async () => {});
    expect(handle().data.loading).toBe(false);
    expect(handle().data.specs.every((s) => s.project === "sail-mast")).toBe(true);

    await act(async () => {
      await gateway.updateSpec("mast-kanban-board", { status: "review" });
    });
    expect(handle().data.loading).toBe(false);
  });

  test("move issues the PUT with If-Match and applies the result", async () => {
    const gateway = createDemoGateway();
    const { handle } = await render(gateway);

    const result = { outcome: undefined as MoveOutcome | undefined };
    await act(async () => {
      result.outcome = (await handle().move("chorus-billing-export", "in_progress")).outcome;
    });
    expect(result.outcome).toBe("ok");
    expect(handle().data.specs.find((s) => s.id === "chorus-billing-export")?.status).toBe(
      "in_progress",
    );
  });

  test("a rejecting gateway clears loading and surfaces an error, never hangs", async () => {
    const gateway = createDemoGateway();
    gateway.listSpecs = () => Promise.reject(new Error("bridge died"));
    const { handle } = await render(gateway);
    expect(handle().data.loading).toBe(false);
    expect(handle().data.error?.code).toBe("bridge");
    expect(handle().data.error?.message).toContain("bridge died");
  });

  test("a concurrent writer surfaces a conflict, not an overwrite", async () => {
    const gateway = createDemoGateway();
    const { handle } = await render(gateway);

    await gateway.updateSpec("chorus-billing-export", { title: "changed elsewhere" });
    await act(async () => {});

    const result = { outcome: undefined as MoveOutcome | undefined };
    await act(async () => {
      result.outcome = (await handle().move("chorus-billing-export", "in_progress")).outcome;
    });
    expect(result.outcome).toBe("conflict");
  });

  test("a failed move surfaces the backend error so the UI can toast it", async () => {
    const gateway = createDemoGateway();
    gateway.updateSpec = async () => ({
      ok: false,
      error: { status: 422, code: "invalid_transition", message: "draft cannot go straight to done" },
    });
    const { handle } = await render(gateway);

    let out: { outcome: MoveOutcome; error?: { message: string } } | undefined;
    await act(async () => {
      out = await handle().move("chorus-billing-export", "in_progress");
    });
    expect(out?.outcome).toBe("error");
    expect(out?.error?.message).toBe("draft cannot go straight to done");
  });
});

describe("lifecycle transitions", () => {
  test("one step forward/back, archive from anywhere, unarchive to draft", () => {
    expect(canTransition("draft", "pending")).toBe(true);
    expect(canTransition("pending", "draft")).toBe(true);
    expect(canTransition("review", "in_progress")).toBe(true);
    expect(canTransition("review", "awaiting_merge")).toBe(true);
    expect(canTransition("awaiting_merge", "done")).toBe(true);
    expect(canTransition("awaiting_merge", "review")).toBe(true);
    expect(canTransition("review", "done")).toBe(false);
    expect(canTransition("draft", "done")).toBe(false);
    expect(canTransition("pending", "review")).toBe(false);
    expect(canTransition("done", "archived")).toBe(true);
    expect(canTransition("archived", "draft")).toBe(true);
    expect(canTransition("archived", "done")).toBe(false);
  });
});
