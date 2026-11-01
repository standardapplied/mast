import { describe, expect, test } from "bun:test";
import {
  jsonText,
  PANEL_SECTIONS,
  portsFrom,
  readJson,
  refusedLine,
  repoPath,
  SECTIONS,
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
    expect(syntaxLine('{\n  "a": "tab\there"\n}')).toBe(2);
    expect(syntaxLine('{\n  "a": "\\q"\n}')).toBe(2);
    expect(syntaxLine('{"a": "\\u12g4"}')).toBe(1);
    expect(syntaxLine('{"a": "\\u00e9 \\n \\" \\\\"}')).toBe(0);
  });

  test("a refusal names its element by index and is placed on that element's field", () => {
    const stages =
      '{\n  "stages": [\n    {\n      "name": "review",\n      "brief": "One."\n    },\n    {\n      "name": "lint",\n      "brief": ""\n    }\n  ]\n}';

    expect(refusedLine(stages, "pipeline", "pipeline.stages[1].brief must not be empty.")).toBe(9);
    expect(refusedLine(stages, "pipeline", "pipeline.stages[0].brief must not be empty.")).toBe(5);
    expect(refusedLine(stages, "pipeline", "pipeline.stages[].name is required.")).toBe(4);
    expect(refusedLine('{\n  "x-1": {\n    "B2": 3\n  }\n}', "agent", "agent.x-1.B2 is wrong.")).toBe(3);
    expect(refusedLine("not json", "agent", "agent.type is wrong.")).toBeNull();
  });

  test("a refusal is placed on the line that keys the field it names", () => {
    const text = '{\n  "type": "claude-code",\n  "guardrails": {\n    "max_duration": "90"\n  }\n}';

    expect(refusedLine(text, "agent", "agent.guardrails.max_duration '90' is not a duration.")).toBe(4);
    expect(refusedLine(text, "agent", "guardrails.max_duration '90' is not a duration.")).toBe(4);
    expect(
      refusedLine('{\n  "stages": [\n    {"name": "lint", "gate": "x"}\n  ]\n}', "pipeline", "pipeline.stages[0].gate 'x' is not a gate."),
    ).toBe(3);
    expect(refusedLine(text, "agent", "agent.member must be a block of keys.")).toBeNull();
    expect(refusedLine(text, "agent", "The agent section of 'acme' changed since you read it.")).toBeNull();
    expect(refusedLine(text, "agent", "agent is not valid")).toBeNull();
    expect(
      refusedLine('{\n  "member": {\n    "agent": "codex"\n  }\n}', "agent", "agent must be a block of keys."),
    ).toBeNull();
  });

});

describe("a repo path and ports", () => {
  test("a repo's path defaults to its URL's last part, and ports are whole numbers", () => {
    expect(repoPath("https://github.com/acme/web.git")).toBe("web");
    expect(repoPath("https://github.com/acme/web/")).toBe("web");
    expect(portsFrom("5432, 5433")).toEqual([5432, 5433]);
    expect(portsFrom("")).toEqual([]);
    expect(portsFrom("5432, x")).toBeNull();
  });
});
