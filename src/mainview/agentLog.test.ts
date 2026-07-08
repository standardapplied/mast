import { describe, expect, test } from "bun:test";
import { renderAgentLine } from "./agentLog";

/** Mirrors sail's AgentLogRendererTest so the two renderers stay byte-compatible. */
describe("renderAgentLine", () => {
  test("renders assistant text", () => {
    const line = `{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the config file."}]}}`;
    expect(renderAgentLine(line)).toBe("Reading the config file.");
  });

  test("renders a tool_use as a one-line summary", () => {
    const line = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"mvn test"}}]}}`;
    const rendered = renderAgentLine(line);
    expect(rendered).toContain("Bash");
    expect(rendered).toContain("mvn test");
    expect(rendered).not.toContain("\n");
    expect(rendered).toBe("⚙ Bash(mvn test)");
  });

  test("collapses a multi-block assistant message to one line per block", () => {
    const line = `{"type":"assistant","message":{"content":[{"type":"text","text":"Now I'll run it."},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}`;
    expect(renderAgentLine(line)).toBe("Now I'll run it.\n⚙ Bash(ls)");
  });

  test("summarizes an input with no known key by its key set", () => {
    const line = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Weird","input":{"foo":1,"bar":2}}]}}`;
    expect(renderAgentLine(line)).toBe("⚙ Weird([foo, bar])");
  });

  test("truncates an overlong summary at 160 chars", () => {
    const long = "x".repeat(300);
    const line = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"${long}"}}]}}`;
    const rendered = renderAgentLine(line);
    expect(rendered.endsWith("…)")).toBe(true);
    expect(rendered).toContain("⚙ Bash(");
  });

  test("renders tool_result status ok and error", () => {
    const ok = `{"type":"user","message":{"content":[{"type":"tool_result","content":"done"}]}}`;
    const err = `{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"boom"}]}}`;
    expect(renderAgentLine(ok)).toBe("  ↳ ok");
    expect(renderAgentLine(err).toLowerCase()).toContain("error");
  });

  test("surfaces the final result", () => {
    const line = `{"type":"result","subtype":"success","result":"All tests pass."}`;
    expect(renderAgentLine(line)).toContain("All tests pass.");
    expect(renderAgentLine(line)).toBe("── result ──\nAll tests pass.");
  });

  test("skips the noisy system/init event", () => {
    const line = `{"type":"system","subtype":"init","model":"claude","tools":["Bash"]}`;
    expect(renderAgentLine(line)).toBe("");
  });

  test("passes plain text through untouched", () => {
    const line = "Codex: applying patch to src/main.rs";
    expect(renderAgentLine(line)).toBe(line);
  });

  test("passes a colon line (non-JSON) through untouched", () => {
    const line = "key: a human readable colon line";
    expect(renderAgentLine(line)).toBe(line);
  });

  test("tolerates malformed JSON", () => {
    expect(renderAgentLine("{not valid json")).toBe("{not valid json");
  });

  test("passes a comment and a bare scalar line through", () => {
    expect(renderAgentLine("# Summary of changes")).toBe("# Summary of changes");
    expect(renderAgentLine("Building the project now")).toBe("Building the project now");
  });

  test("blank lines render to empty", () => {
    expect(renderAgentLine("")).toBe("");
    expect(renderAgentLine("   ")).toBe("");
  });

  test("a valid JSON object without a string type is left untouched", () => {
    const line = `{"foo":1,"bar":"baz"}`;
    expect(renderAgentLine(line)).toBe(line);
  });
});
