import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DefinitionSection } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { DefinitionPanel } from "./DefinitionPanel";
import { createDemoDefinitions, type DemoDefinitions } from "./definitionDemo";

let root: Root;
let container: HTMLElement;

type Writes = { section: DefinitionSection; value: unknown; tag: string }[];

function harness(
  options: {
    refuse?: SailResult<never>;
    failRead?: boolean;
    failRereadAfterConflict?: boolean;
    hold?: boolean;
  } = {},
) {
  const demo: DemoDefinitions = createDemoDefinitions([
    {
      name: "acme",
      image: "ubuntu/24.04",
      resources: { cpu: 2, memory: "8GB", disk: "50GB" },
      services: { redis: { image: "redis:7", ports: [6379] } },
      agent: { type: "claude-code", guardrails: { max_duration: "4h" } },
    },
  ]);
  const writes: Writes = [];
  const held: (() => void)[] = [];
  let reads = 0;
  const closed: number[] = [];
  const catalog = {
    readDefinition: async (project: string) => {
      reads += 1;
      if (options.failRead || (options.failRereadAfterConflict && reads > 1)) {
        return { ok: false as const, error: { status: 503, code: "unavailable", message: "The box is not answering." } };
      }
      return demo.get(project);
    },
    writeSection: async (project: string, section: DefinitionSection, value: unknown, tag: string) => {
      writes.push({ section, value, tag });
      if (options.hold) await new Promise<void>((release) => held.push(release));
      return options.refuse ?? demo.write(project, section, value, tag);
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <DefinitionPanel
        catalog={catalog}
        project="acme"
        now={() => Date.parse("2026-10-30T09:40:00Z")}
        onClose={() => closed.push(1)}
      />,
    ),
  );
  return { catalog: demo, writes, closed, reads: () => reads, release: () => held.shift()!() };
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const find = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const field = (label: string) =>
  (document.getElementById(label) ??
    document.querySelector(`[aria-label="${label}"]`)) as HTMLInputElement | HTMLTextAreaElement;
const buttonIn = (scope: Element, label: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = async (element: HTMLElement) => {
  act(() => element.click());
  await settle();
};
const navItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".def-nav__item")].find(
    (b) => b.textContent?.replace(", unsaved", "") === label,
  )!;
const section = async (label: string) => click(navItem(label));

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DefinitionPanel", () => {
  test("opens on the definition's resources with who changed it last", async () => {
    harness();
    await settle();

    expect(find("definition-panel")?.textContent).toContain("Last changed by uday · 40m");
    expect(field("def-cpu").value).toBe("2");
    expect(field("def-memory").value).toBe("8GB");
    expect(button("Save resources").disabled).toBe(true);
    expect(find("definition-panel")?.textContent).toContain("sail project apply acme");
  });

  test("a form's edit saves its section over the tag it was read at, and nothing else", async () => {
    const h = harness();
    await settle();

    type(field("def-cpu"), "4");
    expect(document.querySelector(".def-footer__note")?.textContent).toBe("Unsaved changes in Resources");
    await click(button("Save resources"));

    expect(h.writes).toEqual([
      { section: "resources", value: { cpu: 4, memory: "8GB", disk: "50GB" }, tag: '{"cpu":2,"memory":"8GB","disk":"50GB"}' },
    ]);
    const held = h.catalog.get("acme");
    expect(held.ok && held.value.definition.resources).toEqual({ cpu: 4, memory: "8GB", disk: "50GB" });
    expect(held.ok && held.value.definition.services).toEqual({ redis: { image: "redis:7", ports: [6379] } });
    expect(document.querySelector(".def-footer__note")?.textContent).toBe("Saved");
  });

  test("a field the form cannot hold is refused before anything is sent", async () => {
    const h = harness();
    await settle();

    type(field("def-cpu"), "four");
    await click(button("Save resources"));

    expect(find("def-refusal")?.textContent).toBe("resources.cpu must be a whole number.");
    expect(h.writes).toEqual([]);
  });

  test("JSON that is not JSON is refused on its line and nothing is sent", async () => {
    const h = harness();
    await settle();
    await section("Agent");

    type(field("Agent JSON"), '{\n  "type": "codex",\n}');
    await click(button("Save agent"));

    expect(find("def-refusal")?.textContent).toBe("Line 3: This is not JSON.");
    expect(document.querySelector(".def-json__gutter .is-error")?.textContent).toBe("3");
    expect(h.writes).toEqual([]);
  });

  test("a refusal from the box is its sentence, on the line of the field it names", async () => {
    harness({
      refuse: {
        ok: false,
        error: {
          status: 422,
          code: "invalid_request",
          message: "agent.guardrails.max_duration '90' is not a duration.",
        },
      },
    });
    await settle();
    await section("Agent");

    type(field("Agent JSON"), '{\n  "type": "claude-code",\n  "guardrails": {\n    "max_duration": "90"\n  }\n}');
    await click(button("Save agent"));

    expect(find("def-refusal")?.textContent).toBe("agent.guardrails.max_duration '90' is not a duration.");
    expect(document.querySelector(".def-json__gutter .is-error")?.textContent).toBe("4");
  });

  test("a section changed meanwhile is refused, the edit stays, and theirs can be seen or saved over", async () => {
    const h = harness();
    await settle();
    await section("Services");
    type(field("def-service-0-image"), "redis:8");
    h.catalog.touch("acme", "services", { redis: { image: "valkey:8", ports: [6379] } });

    await click(button("Save services"));

    expect(find("def-conflict")?.textContent).toContain(
      "Services changed since you opened it. Your edit is still here and nothing was saved.",
    );
    expect(field("def-service-0-image").value).toBe("redis:8");
    expect(find("definition-panel")?.textContent).toContain("Last changed by ravi");

    await click(button("Show theirs"));
    expect(field("Theirs · Services JSON").value).toContain('"image": "valkey:8"');
    await click(button("Back to my edit"));
    expect(field("def-service-0-image").value).toBe("redis:8");

    await click(button("Save mine over it"));
    const held = h.catalog.get("acme");
    expect(held.ok && held.value.definition.services).toEqual({ redis: { image: "redis:8", ports: [6379] } });
    expect(find("def-conflict")).toBeNull();
    expect(h.writes.map((w) => w.tag)).toEqual([
      '{"redis":{"image":"redis:7","ports":[6379]}}',
      '{"redis":{"image":"valkey:8","ports":[6379]}}',
    ]);
  });

  test("a conflict whose new version cannot be read says why", async () => {
    const h = harness({ failRereadAfterConflict: true });
    await settle();
    type(field("def-cpu"), "3");
    h.catalog.touch("acme", "resources", { cpu: 8 });

    await click(button("Save resources"));

    expect(find("def-refusal")?.textContent).toBe("The box is not answering.");
    expect(h.reads()).toBe(2);
  });

  test("each section keeps its own edit; Discard drops only the one on screen", async () => {
    harness();
    await settle();
    type(field("def-cpu"), "6");
    await section("Runtimes");
    type(field("def-node"), "24");
    await click(button("Discard"));

    expect(field("def-node").value).toBe("");
    await section("Resources");
    expect(field("def-cpu").value).toBe("6");
    expect(document.querySelectorAll(".def-nav__dot")).toHaveLength(1);
    expect(navItem("Resources").textContent).toBe("Resources, unsaved");
  });

  test("closing with unsaved edits asks first, and Discard and close closes", async () => {
    const h = harness();
    await settle();
    type(field("def-cpu"), "6");

    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);
    expect(find("def-leaving")?.textContent).toContain("Unsaved changes in Resources.");
    expect(h.closed).toEqual([]);
    await click(button("Keep editing"));
    expect(find("def-leaving")).toBeNull();

    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);
    await click(button("Discard and close"));
    expect(h.closed).toEqual([1]);
  });

  test("closing with nothing unsaved closes at once", async () => {
    const h = harness();
    await settle();

    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);

    expect(h.closed).toEqual([1]);
  });

  test("a definition that cannot be read says why", async () => {
    harness({ failRead: true });
    await settle();

    expect(find("definition-panel")?.textContent).toBe("The box is not answering.");
  });

  test("every form section edits its own fields", async () => {
    const h = harness();
    await settle();

    await section("Repos");
    await click(button("Repo"));
    type(field("Repo URL"), "https://github.com/acme/web.git");
    await click(button("Save repos"));

    await section("Processes");
    await click(button("+ Process"));
    type(field("def-process-0-name"), "web");
    type(field("def-process-0-command"), "npm run dev");
    type(field("def-process-0-port"), "3000");
    await click(button("Variable"));
    type(field("Environment name"), "NODE_ENV");
    type(field("Environment value"), "development");
    await click(button("Save processes"));

    await section("Services");
    await click(button("+ Service"));
    type(field("def-service-1-name"), "db");
    type(field("def-service-1-image"), "postgres:16");
    type(field("def-service-1-ports"), "5432");
    const db = find("def-service-1")!;
    await click(buttonIn(db, "Volume"));
    type(db.querySelector<HTMLInputElement>('[aria-label="Volumes"]')!, "pgdata:/var/lib/postgresql/data");
    await click(button("Save services"));

    await section("Packages");
    type(field("Packages JSON"), '["jq"]');
    await click(button("Save packages"));

    const held = h.catalog.get("acme");
    expect(held.ok && held.value.definition).toEqual({
      name: "acme",
      image: "ubuntu/24.04",
      resources: { cpu: 2, memory: "8GB", disk: "50GB" },
      services: {
        redis: { image: "redis:7", ports: [6379] },
        db: { image: "postgres:16", ports: [5432], volumes: ["pgdata:/var/lib/postgresql/data"] },
      },
      agent: { type: "claude-code", guardrails: { max_duration: "4h" } },
      repos: [{ url: "https://github.com/acme/web.git", path: "web" }],
      processes: { web: { command: "npm run dev", port: 3000, env: { NODE_ENV: "development" } } },
      packages: ["jq"],
    });
  });

  test("every field of every form writes its own key, and a removed row is gone", async () => {
    const h = harness();
    await settle();

    type(field("def-memory"), "16GB");
    type(field("def-disk"), "80GB");
    await click(button("Save resources"));

    await section("Runtimes");
    type(field("def-jdk"), "26");
    type(field("def-maven"), "3.9.14");
    await click(button("Save runtimes"));

    await section("Repos");
    await click(button("Repo"));
    type(field("Repo URL"), "https://github.com/acme/api.git");
    type(field("Repo path"), "backend");
    type(field("Repo branch"), "main");
    await click(button("Repo"));
    await click(document.querySelectorAll<HTMLButtonElement>('[aria-label="Remove repo"]')[0]!);
    await click(button("Save repos"));

    await section("Services");
    const redis = find("def-service-0")!;
    type(field("def-service-0-ports"), "6379, 6380");
    type(field("def-service-0-command"), "redis-server --save ''");
    await click(buttonIn(redis, "Variable"));
    type(redis.querySelector<HTMLInputElement>('[aria-label="Environment name"]')!, "MODE");
    type(redis.querySelector<HTMLInputElement>('[aria-label="Environment value"]')!, "dev");
    await click(buttonIn(redis, "Variable"));
    await click(redis.querySelector<HTMLButtonElement>('[aria-label="Remove Environment"]')!);
    await click(buttonIn(redis, "Volume"));
    await click(buttonIn(redis, "Volume"));
    type(redis.querySelectorAll<HTMLInputElement>('[aria-label="Volumes"]')[0]!, "data:/data");
    await click(redis.querySelector<HTMLButtonElement>('[aria-label="Remove data:/data"]')!);
    await click(button("+ Service"));
    await click(buttonIn(find("def-service-1")!, "Remove"));
    await click(button("Save services"));

    await section("Processes");
    await click(button("+ Process"));
    type(field("def-process-0-name"), "web");
    type(field("def-process-0-command"), "npm run dev");
    type(field("def-process-0-workdir"), "web");
    await click(button("+ Process"));
    await click(buttonIn(find("def-process-1")!, "Remove"));
    await click(button("Save processes"));

    const held = h.catalog.get("acme");
    expect(held.ok && held.value.definition).toEqual({
      name: "acme",
      image: "ubuntu/24.04",
      resources: { cpu: 2, memory: "16GB", disk: "80GB" },
      services: {
        redis: { image: "redis:7", ports: [6379, 6380], environment: { MODE: "dev" }, command: "redis-server --save ''" },
      },
      agent: { type: "claude-code", guardrails: { max_duration: "4h" } },
      runtimes: { jdk: 26, maven: "3.9.14" },
      repos: [{ url: "https://github.com/acme/api.git", path: "backend", branch: "main" }],
      processes: { web: { command: "npm run dev", workdir: "web" } },
    });
  });

  test("a saved section saves again over its new version", async () => {
    const h = harness();
    await settle();

    type(field("def-cpu"), "4");
    await click(button("Save resources"));
    type(field("def-cpu"), "6");
    await click(button("Save resources"));

    expect(find("def-conflict")).toBeNull();
    const held = h.catalog.get("acme");
    expect(held.ok && held.value.definition.resources).toEqual({ cpu: 6, memory: "8GB", disk: "50GB" });
  });

  test("a section is written only over the version its own edit read, whatever another section's conflict refreshed", async () => {
    const h = harness();
    await settle();
    type(field("def-cpu"), "4");
    await section("Services");
    type(field("def-service-0-image"), "redis:8");
    h.catalog.touch("acme", "services", { redis: { image: "valkey:8" } });
    h.catalog.touch("acme", "resources", { cpu: 16, memory: "64GB", disk: "1TB" });

    await click(button("Save services"));
    expect(find("def-conflict")).not.toBeNull();
    await section("Resources");
    await click(button("Save resources"));

    expect(find("def-conflict")?.textContent).toContain("Resources changed since you opened it.");
    const held = h.catalog.get("acme");
    expect(held.ok && held.value.definition.resources).toEqual({ cpu: 16, memory: "64GB", disk: "1TB" });
  });

  test("an edit typed while its section saves stays, over the version the save made", async () => {
    const h = harness({ hold: true });
    await settle();

    type(field("def-cpu"), "4");
    act(() => button("Save resources").click());
    type(field("def-cpu"), "6");
    h.release();
    await settle();

    expect(field("def-cpu").value).toBe("6");
    expect(document.querySelector(".def-footer__note")?.textContent).toBe("Unsaved changes in Resources");
    act(() => button("Save resources").click());
    h.release();
    await settle();
    expect(find("def-conflict")).toBeNull();
    const kept = h.catalog.get("acme");
    expect(kept.ok && kept.value.definition.resources?.cpu).toBe(6);
  });

  test("a conflict outlives another section's save and saves over exactly the version it showed", async () => {
    const h = harness();
    await settle();
    type(field("def-cpu"), "4");
    h.catalog.touch("acme", "resources", { cpu: 8, memory: "8GB", disk: "50GB" });
    await click(button("Save resources"));
    expect(find("def-conflict")).not.toBeNull();

    h.catalog.touch("acme", "resources", { cpu: 16, memory: "8GB", disk: "50GB" });
    await section("Runtimes");
    type(field("def-node"), "24");
    await click(button("Save runtimes"));
    await section("Resources");
    expect(find("def-conflict")?.textContent).toContain("Resources changed since you opened it.");
    await click(button("Show theirs"));
    expect(field("Theirs · Resources JSON").value).toContain('"cpu": 8');

    await click(button("Save mine over it"));

    expect(find("def-conflict")?.textContent).toContain("Resources changed since you opened it.");
    const still = h.catalog.get("acme");
    expect(still.ok && still.value.definition.resources?.cpu).toBe(16);
  });

  test("a refusal stays on its section when another section saves", async () => {
    harness();
    await settle();
    await section("Agent");
    type(field("Agent JSON"), "{");
    await click(button("Save agent"));
    await section("Runtimes");
    type(field("def-node"), "24");
    await click(button("Save runtimes"));
    await section("Agent");

    expect(find("def-refusal")?.textContent).toBe("Line 1: This is not JSON.");
    expect(field("Agent JSON").getAttribute("aria-invalid")).toBe("true");
    expect(field("Agent JSON").getAttribute("aria-describedby")).toBe("def-refusal");
  });

  test("the warning about closing goes once nothing is left unsaved", async () => {
    harness();
    await settle();
    type(field("def-cpu"), "6");
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);
    expect(find("def-leaving")).not.toBeNull();

    await click(button("Save resources"));

    expect(find("def-leaving")).toBeNull();
  });
});
