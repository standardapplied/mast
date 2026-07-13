import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GlobalSpecsListResponse } from "../../shared/sail-models";
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
