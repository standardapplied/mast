import { describe, expect, test } from "bun:test";
import {
  changed,
  jsonText,
  NEW_PROJECT,
  newProjectDocument,
  PANEL_SECTIONS,
  portsFrom,
  readJson,
  refusedLine,
  repoPath,
  SECTIONS,
  SERVICE_PRESETS,
  syntaxLine,
} from "./definition";

describe("sections", () => {
  test("the panel edits every section but the name, description and image, forms first", () => {
    expect(PANEL_SECTIONS.map((s) => s.key)).toEqual(
      SECTIONS.filter((s) => s !== "description" && s !== "image"),
    );
    expect(PANEL_SECTIONS.filter((s) => s.editor === "json").map((s) => s.key)).toEqual([
      "packages",
      "agent",
      "pipeline",
    ]);
  });
});

describe("a JSON section", () => {
  test("shows its value pretty and an unset section empty", () => {
    expect(jsonText({ type: "codex", install: ["codex"] })).toBe(
      '{\n  "type": "codex",\n  "install": [\n    "codex"\n  ]\n}',
    );
    expect(jsonText(undefined)).toBe("");
    expect(jsonText(null)).toBe("");
  });

  test("reads back as its value, empty text unsetting it", () => {
    expect(readJson('{"type": "codex"}')).toEqual({ ok: true, value: { type: "codex" } });
    expect(readJson("  \n")).toEqual({ ok: true, value: null });
    expect(readJson('{\n  "type": "codex",\n}')).toEqual({ ok: false, line: 3, message: "This is not JSON." });
  });

  test("text that is not JSON is placed on the line it stops on", () => {
    expect(syntaxLine('{"a": 1}')).toBe(0);
    expect(syntaxLine('[1, 2.5e3, -0, true, false, null, "x\\"y", {}, []]')).toBe(0);
    expect(syntaxLine('{\n  "a": 1\n  "b": 2\n}')).toBe(3);
    expect(syntaxLine('{\n  "a": tru\n}')).toBe(2);
    expect(syntaxLine('{\n  a: 1\n}')).toBe(2);
    expect(syntaxLine('{\n  "a" 1\n}')).toBe(2);
    expect(syntaxLine('{\n  "a": "open\n}')).toBe(2);
    expect(syntaxLine('{"a": "never closed')).toBe(1);
    expect(syntaxLine('[1,\n2,\n]')).toBe(3);
    expect(syntaxLine("[1 2]")).toBe(1);
    expect(syntaxLine('{"a": 1}\n\nextra')).toBe(3);
    expect(syntaxLine("{")).toBe(1);
    expect(syntaxLine("01")).toBe(1);
  });

  test("a refusal is placed on the line that keys the field it names", () => {
    const text = '{\n  "type": "claude-code",\n  "guardrails": {\n    "max_duration": "90"\n  }\n}';

    expect(refusedLine(text, "agent", "agent.guardrails.max_duration '90' is not a duration.")).toBe(4);
    expect(refusedLine(text, "agent", "guardrails.max_duration '90' is not a duration.")).toBe(4);
    expect(refusedLine('[\n  {"name": "lint", "gate": "x"}\n]', "pipeline", "pipeline.stages[0].gate 'x' is not a gate.")).toBe(2);
    expect(refusedLine(text, "agent", "agent.member must be a block of keys.")).toBeNull();
    expect(refusedLine(text, "agent", "The agent section of 'acme' changed since you read it.")).toBeNull();
    expect(refusedLine(text, "agent", "agent is not valid")).toBeNull();
  });

  test("is changed when its value differs from the box's, unset and null alike", () => {
    expect(changed({ a: 1 }, { a: 1 })).toBe(false);
    expect(changed(null, undefined)).toBe(false);
    expect(changed({ a: 2 }, { a: 1 })).toBe(true);
  });
});

describe("a new project", () => {
  test("is what sail project create writes for the same answers", () => {
    expect(newProjectDocument({ ...NEW_PROJECT, name: " acme-web " })).toEqual({
      name: "acme-web",
      image: "ubuntu/24.04",
      resources: { cpu: 2, memory: "8GB", disk: "50GB" },
      agent: { type: "claude-code", auto_branch: true, branch_prefix: "agent/", auto_snapshot: true },
    });
    expect(
      newProjectDocument({
        ...NEW_PROJECT,
        name: "acme-web",
        description: " Storefront ",
        runtimes: new Set(["maven", "jdk"]),
        repos: [{ url: "https://github.com/acme/web.git", path: "web" }],
        services: { redis: SERVICE_PRESETS[1]!.service },
      }),
    ).toEqual({
      name: "acme-web",
      description: "Storefront",
      image: "ubuntu/24.04",
      resources: { cpu: 2, memory: "8GB", disk: "50GB" },
      runtimes: { jdk: 26, maven: "3.9.14" },
      repos: [{ url: "https://github.com/acme/web.git", path: "web" }],
      services: { redis: { image: "redis:7", ports: [6379] } },
      agent: { type: "claude-code", auto_branch: true, branch_prefix: "agent/", auto_snapshot: true },
    });
  });

  test("a repo's path defaults to its URL's last part, and ports are whole numbers", () => {
    expect(repoPath("https://github.com/acme/web.git")).toBe("web");
    expect(repoPath("https://github.com/acme/web/")).toBe("web");
    expect(portsFrom("5432, 5433")).toEqual([5432, 5433]);
    expect(portsFrom("")).toEqual([]);
    expect(portsFrom("5432, x")).toBeNull();
  });
});
