/**
 * Collapses one raw agent-log line into a readable progress line — a faithful
 * port of sail's `AgentLogRenderer` (engine/AgentLogRenderer.java), so the
 * desktop follower shows exactly what `sail agent log` prints.
 *
 * Dispatched claude-code agents stream newline-delimited JSON (`--output-format
 * stream-json`); each such line collapses to assistant text, a one-line
 * tool-call summary, a tool-result status, or the final result. Any line that
 * isn't a recognised stream-json event (codex's already-readable transcript, or
 * a pre-stream-json log) passes through untouched — so the same renderer is
 * correct for both agents and for old logs. The unprocessed line is always
 * available behind the UI's raw toggle.
 */

const SUMMARY_LIMIT = 160;
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "description", "prompt"];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The readable form for a stream-json event, the line unchanged for plain text,
 * and an empty string for events that carry no progress (e.g. `system/init`).
 */
export function renderAgentLine(line: string): string {
  if (!line || line.trim() === "") return "";
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(event) || typeof event.type !== "string") return line;
  switch (event.type) {
    case "assistant":
      return renderAssistant(event);
    case "user":
      return renderUser(event);
    case "result":
      return renderResult(event);
    case "system":
      return "";
    default:
      return line;
  }
}

function contentBlocks(event: JsonObject): JsonObject[] {
  if (isObject(event.message) && Array.isArray(event.message.content)) {
    return event.message.content.filter(isObject);
  }
  return [];
}

function renderAssistant(event: JsonObject): string {
  const lines: string[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type === "text") {
      const text = String(block.text ?? "").trim();
      if (text) lines.push(text);
    } else if (block.type === "tool_use") {
      lines.push(`⚙ ${String(block.name ?? "tool")}${summarizeInput(block.input)}`);
    }
  }
  return lines.join("\n");
}

function renderUser(event: JsonObject): string {
  const lines: string[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type === "tool_result") {
      lines.push(block.is_error === true ? "  ↳ error" : "  ↳ ok");
    }
  }
  return lines.join("\n");
}

function renderResult(event: JsonObject): string {
  const result = String(event.result ?? "").trim();
  return result === "" ? "" : `── result ──\n${result}`;
}

function summarizeInput(input: unknown): string {
  if (!isObject(input)) return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  for (const key of SUMMARY_KEYS) {
    if (input[key] != null) return `(${truncate(oneLine(String(input[key])))})`;
  }
  return `(${truncate(oneLine(`[${keys.join(", ")}]`))})`;
}

function oneLine(value: string): string {
  return value.replace(/[\n\r]/g, " ").trim();
}

function truncate(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}…`;
}
