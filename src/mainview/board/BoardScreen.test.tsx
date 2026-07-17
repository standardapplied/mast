import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GlobalSpecsListResponse, GlobalSpecView } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { ToastProvider } from "../components/Toast";
import { createDemoGateway, type DemoGateway } from "../gateway";
import { BoardScreen } from "./BoardScreen";

let root: Root;
let container: HTMLElement;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

async function render(gateway: DemoGateway) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <BoardScreen gateway={gateway} onOpenSpec={() => {}} />
      </ToastProvider>,
    ),
  );
  await flush();
}

const projectTrigger = () =>
  container.querySelector<HTMLButtonElement>(".board-project button, .board-project [role='combobox'], .board-project")!;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
});

describe("BoardScreen project dropdown", () => {
  test("a restored project selection shows immediately, even while specs load", async () => {
    sessionStorage.setItem("mast.board.project", "sail-mast");
    const gateway = createDemoGateway();
    let resolve!: (v: SailResult<GlobalSpecsListResponse>) => void;
    const gate = new Promise<SailResult<GlobalSpecsListResponse>>((r) => (resolve = r));
    const realList = gateway.listSpecs.bind(gateway);
    gateway.listSpecs = (filter) => (filter?.project ? gate : realList(filter));

    await render(gateway);
    expect(projectTrigger().textContent).toContain("sail-mast");
    expect(projectTrigger().textContent).not.toContain("All projects");

    await act(async () => {
      resolve(await realList({ project: "sail-mast" }));
      await flush();
    });
    expect(projectTrigger().textContent).toContain("sail-mast");
  });

  test("with no stored selection the dropdown shows All projects", async () => {
    await render(createDemoGateway());
    expect(projectTrigger().textContent).toContain("All projects");
  });
});

describe("BoardScreen cancelled lane", () => {
  test("a cancelled spec renders in its own lane with the lane count badge", async () => {
    const gateway = createDemoGateway();
    await gateway.updateSpec("chorus-invoice-ui", { status: "cancelled" });
    await render(gateway);

    const lane = container.querySelector('[data-testid="column-cancelled"]');
    expect(lane).not.toBeNull();
    expect(lane!.textContent).toContain("Cancelled");
    expect(lane!.querySelector(".badge")!.textContent).toBe("1");
    expect(lane!.querySelector('[data-testid="card-chorus-invoice-ui"]')).not.toBeNull();
  });

  test("a status this client doesn't know never crashes the board", async () => {
    const gateway = createDemoGateway();
    await gateway.updateSpec("chorus-invoice-ui", {
      status: "paused" as GlobalSpecView["status"],
    });
    await render(gateway);

    expect(container.querySelector('[data-testid="column-pending"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="card-chorus-billing-export"]')).not.toBeNull();
  });

  test("the demo stop flow moves the spec to the cancelled lane live", async () => {
    const gateway = createDemoGateway();
    await render(gateway);
    expect(
      container
        .querySelector('[data-testid="column-in_progress"]')!
        .querySelector('[data-testid="card-chorus-invoice-ui"]'),
    ).not.toBeNull();

    await act(async () => {
      await gateway.stopRun("demo-run-chorus-invoice-ui-build");
    });
    await flush();

    expect(
      container
        .querySelector('[data-testid="column-cancelled"]')!
        .querySelector('[data-testid="card-chorus-invoice-ui"]'),
    ).not.toBeNull();
  });
});

describe("BoardScreen live-log gating", () => {
  const liveControl = (id: string) =>
    container.querySelector<HTMLElement>(`[data-testid="card-live-${id}"]`)!;

  test("own spec: the Live control opens the log drawer", async () => {
    await render(createDemoGateway());
    const live = liveControl("chorus-invoice-ui");
    expect(live.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => live.click());
    expect(container.querySelector('[data-testid="live-log"]')).not.toBeNull();
  });

  test("foreign spec: the Live control is disabled with an explanation and never opens", async () => {
    const gateway = createDemoGateway();
    const whoami = gateway.whoami.bind(gateway);
    gateway.whoami = async () => {
      const result = await whoami();
      return result.ok ? { ...result, value: { ...result.value, fde: "sumesh" } } : result;
    };
    await render(gateway);

    const live = liveControl("chorus-invoice-ui");
    expect(live.getAttribute("aria-disabled")).toBe("true");
    expect(live.title).toContain("uday");
    await act(async () => live.click());
    expect(container.querySelector('[data-testid="live-log"]')).toBeNull();
  });
});
