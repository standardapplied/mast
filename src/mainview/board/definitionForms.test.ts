import { describe, expect, test } from "bun:test";
import {
  modelOf,
  NEW_PROJECT,
  newProjectDocument,
  SERVICE_PRESETS,
  processesForm,
  readModel,
  readProcesses,
  readRepos,
  readResources,
  readRuntimes,
  readServices,
  reposForm,
  resourcesForm,
  runtimesForm,
  servicesForm,
} from "./definitionForms";

describe("each form reads back as the value it was made from", () => {
  test("resources and runtimes, an empty form unsetting its section", () => {
    const resources = { cpu: 4, memory: "16GB", disk: "80GB" };
    const runtimes = { jdk: 26, node: "24", maven: "3.9.14" };

    expect(readResources(resourcesForm(resources))).toEqual({ ok: true, value: resources });
    expect(readRuntimes(runtimesForm(runtimes))).toEqual({ ok: true, value: runtimes });
    expect(readResources(resourcesForm(undefined))).toEqual({ ok: true, value: null });
    expect(readRuntimes({ jdk: "", node: " 22 ", maven: "" })).toStrictEqual({ ok: true, value: { node: "22" } });
    expect(readResources({ cpu: "", memory: "8GB", disk: "" })).toStrictEqual({ ok: true, value: { memory: "8GB" } });
  });

  test("repos, a path left blank taking the URL's last part and a held forge kept", () => {
    const held = [{ url: "https://git.acme.dev/web.git", path: "web", forge: "github" }];

    expect(readRepos(reposForm(held))).toEqual({ ok: true, value: held });
    expect(
      readRepos(reposForm(held).map((row) => ({ ...row, url: "https://git.acme.dev/web2.git" }))),
    ).toEqual({ ok: true, value: [{ ...held[0]!, url: "https://git.acme.dev/web2.git" }] });
    expect(
      readRepos(
        [
          { url: " https://github.com/acme/api.git ", path: "", branch: " main ", forge: "" },
          { url: "", path: "", branch: "", forge: "" },
        ],
      ),
    ).toEqual({ ok: true, value: [{ url: "https://github.com/acme/api.git", path: "api", branch: "main" }] });
    expect(readRepos([])).toEqual({ ok: true, value: null });
  });

  test("services and processes, blank rows dropped", () => {
    const services = {
      postgres: {
        image: "postgres:16",
        ports: [5432],
        environment: { POSTGRES_DB: "app" },
        command: "postgres -c fsync=off",
        volumes: ["pgdata:/var/lib/postgresql/data"],
      },
      redis: { image: "redis:7" },
    };
    const processes = {
      web: { command: "npm run dev", workdir: "web", port: 3000, env: { NODE_ENV: "development" } },
      worker: { command: "npm run worker" },
    };

    expect(readServices(servicesForm(services))).toEqual({ ok: true, value: services });
    expect(readProcesses(processesForm(processes))).toEqual({ ok: true, value: processes });
    expect(
      readServices([
        {
          name: "db",
          image: "postgres:16",
          ports: "",
          environment: [{ key: " ", value: "x" }],
          volumes: [" "],
          command: "",
        },
      ]),
    ).toEqual({ ok: true, value: { db: { image: "postgres:16" } } });
    expect(readServices([])).toEqual({ ok: true, value: null });
    expect(readProcesses([])).toEqual({ ok: true, value: null });
  });
});

describe("a field a form cannot hold is refused naming it as sail does", () => {
  test.each([
    [readResources({ cpu: "four", memory: "", disk: "" }), "resources.cpu must be a whole number."],
    [readRuntimes({ jdk: "26.1", node: "", maven: "" }), "runtimes.jdk must be a whole number."],
    [readRepos([{ url: "", path: "web", branch: "", forge: "" }]), "repos[].url is required."],
    [readResources({ cpu: "0", memory: "", disk: "" }), "resources.cpu must be at least 1."],
    [
      readServices([{ name: "", image: "x", ports: "", environment: [], volumes: [], command: "" }]),
      "services needs a name for every service.",
    ],
    [
      readServices([
        { name: "db", image: "x", ports: "", environment: [], volumes: [], command: "" },
        { name: "db", image: "y", ports: "", environment: [], volumes: [], command: "" },
      ]),
      "services.db is named twice.",
    ],
    [
      readServices([{ name: "db", image: " ", ports: "", environment: [], volumes: [], command: "" }]),
      "services.db.image is required.",
    ],
    [
      readServices([{ name: "db", image: "x", ports: "54x", environment: [], volumes: [], command: "" }]),
      "services.db.ports must be whole numbers, separated by commas.",
    ],
    [readProcesses([{ name: "", command: "x", workdir: "", port: "", env: [] }]), "processes needs a name for every process."],
    [
      readProcesses([
        { name: "web", command: "x", workdir: "", port: "", env: [] },
        { name: "web", command: "y", workdir: "", port: "", env: [] },
      ]),
      "processes.web is named twice.",
    ],
    [readProcesses([{ name: "web", command: "", workdir: "", port: "", env: [] }]), "processes.web.command is required."],
    [
      readProcesses([{ name: "web", command: "x", workdir: "", port: "3k", env: [] }]),
      "processes.web.port must be a whole number.",
    ],
  ])("%p", (read, message) => {
    expect(read).toEqual({ ok: false, message });
  });
});

describe("a section's editor", () => {
  test("holds a form for a form section and JSON text for the rest", () => {
    expect(modelOf("resources", { cpu: 2 })).toEqual({ cpu: "2", memory: "", disk: "" });
    expect(modelOf("runtimes", undefined)).toEqual({ jdk: "", node: "", maven: "" });
    expect(modelOf("repos", undefined)).toEqual([]);
    expect(modelOf("services", undefined)).toEqual([]);
    expect(modelOf("processes", undefined)).toEqual([]);
    expect(modelOf("packages", ["jq"])).toBe('[\n  "jq"\n]');
  });

  test("reads back every section, naming the field or the JSON line it stops on", () => {
    expect(readModel("resources", { cpu: "x", memory: "", disk: "" })).toEqual({
      ok: false,
      message: "resources.cpu must be a whole number.",
      line: null,
    });
    expect(readModel("runtimes", { jdk: "", node: "24", maven: "" })).toEqual({ ok: true, value: { node: "24" } });
    expect(readModel("repos", [])).toEqual({ ok: true, value: null });
    expect(readModel("services", [])).toEqual({ ok: true, value: null });
    expect(readModel("processes", [])).toEqual({ ok: true, value: null });
    expect(readModel("agent", '{"type": "codex"}')).toEqual({ ok: true, value: { type: "codex" } });
    expect(readModel("packages", '[\n  "jq",\n]')).toEqual({
      ok: false,
      message: "Line 3: This is not JSON.",
      line: 3,
    });
  });
});

describe("a new project", () => {
  test("is what sail project create writes for the same answers", () => {
    expect(newProjectDocument({ ...NEW_PROJECT, name: " acme-web " })).toEqual({
      ok: true,
      value: {
        name: "acme-web",
        image: "ubuntu/24.04",
        resources: { cpu: 2, memory: "8GB", disk: "50GB" },
        agent: { type: "claude-code", auto_branch: true, branch_prefix: "agent/", auto_snapshot: true },
      },
    });
    expect(
      newProjectDocument({
        ...NEW_PROJECT,
        name: "acme-web",
        description: " Storefront ",
        runtimes: new Set(["maven", "jdk"]),
        repos: [{ url: "https://github.com/acme/web.git", path: "", branch: "", forge: "" }],
        services: { redis: SERVICE_PRESETS[1]!.service },
      }),
    ).toEqual({
      ok: true,
      value: {
      name: "acme-web",
      description: "Storefront",
      image: "ubuntu/24.04",
      resources: { cpu: 2, memory: "8GB", disk: "50GB" },
      runtimes: { jdk: 26, maven: "3.9.14" },
      repos: [{ url: "https://github.com/acme/web.git", path: "web" }],
      services: { redis: { image: "redis:7", ports: [6379] } },
      agent: { type: "claude-code", auto_branch: true, branch_prefix: "agent/", auto_snapshot: true },
      },
    });
  });

  test("resources it cannot hold are refused before anything is sent", () => {
    expect(newProjectDocument({ ...NEW_PROJECT, name: "a", cpu: "" })).toEqual({
      ok: false,
      message: "resources needs cpu, memory and disk.",
    });
    expect(newProjectDocument({ ...NEW_PROJECT, name: "a", cpu: "2.5" })).toEqual({
      ok: false,
      message: "resources.cpu must be a whole number.",
    });
    expect(
      newProjectDocument({ ...NEW_PROJECT, name: "a", repos: [{ url: "", path: "x", branch: "", forge: "" }] }),
    ).toEqual({ ok: false, message: "repos[].url is required." });
  });
});
