import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProjectListResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { ProjectPicker } from "./ProjectPicker";
import type { RosterSources } from "./projectRoster";

let root: Root;
let container: HTMLElement;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

const catalog = (projects: ProjectListResponse["projects"]): SailResult<ProjectListResponse> => ({
  ok: true,
  value: { projects },
});

function fakeSources(overrides: Partial<RosterSources> = {}): RosterSources {
  return {
    listProjects: async () =>
      catalog([
        { name: "chorus", container_status: "running" },
        { name: "nautilus", container_status: "not_created" },
        { name: "sail-mast", container_status: "stopped" },
      ]),
    listTargets: async () => ["chorus"],
    ...overrides,
  };
}

type Picked = { target: string | undefined; label: string };

async function render(sources: RosterSources, onCancel?: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const picks: Picked[] = [];
  act(() =>
    root.render(
      <ProjectPicker
        sources={sources}
        onPick={(target, label) => picks.push({ target, label })}
        onCancel={onCancel}
      />,
    ),
  );
  await flush();
  return picks;
}

const items = () => [...container.querySelectorAll<HTMLButtonElement>(".term-picker__item")];
const itemNamed = (name: string) =>
  items().find((b) => b.querySelector(".term-picker__name")?.textContent === name);
const metaOf = (name: string) => itemNamed(name)?.querySelector(".term-picker__meta")?.textContent;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ProjectPicker", () => {
  test("lists the full catalog with container states, not just SSH routes", async () => {
    await render(fakeSources());
    expect(items().map((b) => b.querySelector(".term-picker__name")?.textContent)).toEqual([
      "chorus",
      "nautilus",
      "sail-mast",
      "node · devbox",
    ]);
    expect(metaOf("chorus")).toBe("running");
    expect(metaOf("nautilus")).toBe("not created");
    expect(metaOf("sail-mast")).toBe("stopped");
  });

  test("picking a running project opens it as the SSH target", async () => {
    const picks = await render(fakeSources());
    itemNamed("chorus")!.click();
    expect(picks).toEqual([{ target: "chorus", label: "chorus" }]);
  });

  test("stopped and not-created projects are disabled with a hint", async () => {
    const picks = await render(fakeSources());
    const stopped = itemNamed("sail-mast")!;
    expect(stopped.disabled).toBe(true);
    expect(stopped.title).toContain("stopped");
    expect(itemNamed("nautilus")!.disabled).toBe(true);
    stopped.click();
    expect(picks).toEqual([]);
  });

  test("a running project without an SSH route is disabled and says why", async () => {
    await render(fakeSources({ listTargets: async () => [] }));
    const running = itemNamed("chorus")!;
    expect(running.disabled).toBe(true);
    expect(metaOf("chorus")).toBe("running · no ssh route");
    expect(running.title).toContain("sail connect chorus");
  });

  test("the node entry always opens the control-plane host", async () => {
    const picks = await render(fakeSources());
    itemNamed("node · devbox")!.click();
    expect(picks).toEqual([{ target: undefined, label: "node · devbox" }]);
  });

  test("shows a loading hint until the roster resolves", async () => {
    let resolve!: (v: string[]) => void;
    await render(
      fakeSources({ listTargets: () => new Promise<string[]>((r) => (resolve = r)) }),
    );
    expect(container.textContent).toContain("Loading projects…");
    await act(async () => {
      resolve(["chorus"]);
      await flush();
    });
    expect(container.textContent).not.toContain("Loading projects…");
    expect(itemNamed("chorus")).toBeDefined();
  });

  test("a failed catalog degrades to SSH routes with a warning", async () => {
    await render(fakeSources({ listProjects: () => Promise.reject(new Error("api down")) }));
    expect(itemNamed("chorus")!.disabled).toBe(false);
    expect(container.textContent).toContain("Couldn’t load the project catalog (api down)");
  });

  test("both sources failing shows the error and keeps the node entry usable", async () => {
    const picks = await render(
      fakeSources({
        listProjects: () => Promise.reject(new Error("api down")),
        listTargets: () => Promise.reject(new Error("no ssh config")),
      }),
    );
    expect(container.textContent).toContain("Couldn’t load projects: api down; no ssh config");
    itemNamed("node · devbox")!.click();
    expect(picks).toEqual([{ target: undefined, label: "node · devbox" }]);
  });

  test("empty roster shows the getting-started message", async () => {
    await render(fakeSources({ listProjects: async () => catalog([]), listTargets: async () => [] }));
    expect(container.textContent).toContain("No projects yet");
  });

  test("cancel renders only when a handler is given, and fires it", async () => {
    await render(fakeSources());
    expect(container.textContent).not.toContain("Cancel");

    act(() => root.unmount());
    container.remove();

    let cancelled = false;
    await render(fakeSources(), () => (cancelled = true));
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    );
    cancel!.click();
    expect(cancelled).toBe(true);
  });
});
