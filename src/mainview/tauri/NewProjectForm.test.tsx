import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProjectDefinitionDocument, ProjectDefinitionResponse } from "../../shared/sail-models";
import { createDemoDefinitions } from "../board/definitionDemo";
import { NewProjectForm } from "./NewProjectForm";

let root: Root;
let container: HTMLElement;

function harness() {
  const catalog = createDemoDefinitions([{ name: "taken" }]);
  const sent: ProjectDefinitionDocument[] = [];
  const created: ProjectDefinitionResponse[] = [];
  const closed: number[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <NewProjectForm
        gateway={{
          createProject: async (definition) => {
            sent.push(definition);
            return catalog.create(definition);
          },
        }}
        onCreated={(project) => created.push(project)}
        onClose={() => closed.push(1)}
      />,
    ),
  );
  return { sent, created, closed };
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const find = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const field = (id: string) =>
  (document.getElementById(id) ?? document.querySelector(`[aria-label="${id}"]`)) as HTMLInputElement;
const type = (element: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (element: HTMLElement) => {
  act(() => element.click());
  await settle();
};

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NewProjectForm", () => {
  test("creates the project its fields describe, and needs a name first", async () => {
    const h = harness();
    expect((find("new-project-create") as HTMLButtonElement).disabled).toBe(true);

    type(field("new-project-name"), "acme-web");
    type(field("new-project-description"), "Storefront");
    type(field("new-project-image"), "debian/12");
    type(field("new-project-cpu"), "4");
    type(field("new-project-memory"), "16GB");
    type(field("new-project-disk"), "80GB");
    await click(button("JDK 26"));
    await click(button("Node 24"));
    await click(button("Node 24"));
    await click(button("postgres:16 · 5432"));
    await click(button("redis:7 · 6379"));
    await click(button("redis:7 · 6379"));
    await click(button("Repo"));
    type(field("Repo URL"), "https://github.com/acme/web.git");
    await click(find("new-project-create") as HTMLElement);

    expect(h.sent).toEqual([
      {
        name: "acme-web",
        image: "debian/12",
        resources: { cpu: 4, memory: "16GB", disk: "80GB" },
        agent: { type: "claude-code", auto_branch: true, branch_prefix: "agent/", auto_snapshot: true },
        description: "Storefront",
        runtimes: { jdk: 26 },
        repos: [{ url: "https://github.com/acme/web.git", path: "web" }],
        services: {
          postgres: {
            image: "postgres:16",
            ports: [5432],
            environment: { POSTGRES_DB: "app", POSTGRES_USER: "dev", POSTGRES_PASSWORD: "dev" },
            volumes: ["pgdata:/var/lib/postgresql/data"],
          },
        },
      },
    ]);
    expect(h.created.map((c) => c.name)).toEqual(["acme-web"]);
  });

  test("a name taken or a value refused comes back inline and every field stays as typed", async () => {
    const h = harness();
    type(field("new-project-name"), "taken");
    await click(find("new-project-create") as HTMLElement);

    expect(find("new-project-refusal")?.textContent).toBe(
      "A project named 'taken' already exists. — Choose another name, or edit that project's definition.",
    );
    expect(field("new-project-name").value).toBe("taken");

    type(field("new-project-name"), "fresh");
    await click(button("Repo"));
    type(field("Repo URL"), "git@github.com:acme/web.git");
    await click(find("new-project-create") as HTMLElement);
    expect(find("new-project-refusal")?.textContent).toContain("is not an https URL");
    expect(h.created).toEqual([]);
  });

  test("a repo row with no URL is refused before anything is sent, and Cancel closes", async () => {
    const h = harness();
    type(field("new-project-name"), "acme");
    await click(button("Repo"));
    type(field("Repo path"), "web");
    await click(find("new-project-create") as HTMLElement);

    expect(find("new-project-refusal")?.textContent).toBe("repos[].url is required.");
    expect(h.sent).toEqual([]);
    await click(button("Cancel"));
    expect(h.closed).toEqual([1]);
  });
});
