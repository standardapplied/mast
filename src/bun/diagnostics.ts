import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * In-memory ring buffer + optional file sink for connection/HTTP lifecycle
 * events. A module singleton (not injected) so the pure connect/http modules
 * can log cheaply without threading a logger through every seam; it buffers
 * always (harmless in tests) and only touches disk once a file sink is set.
 *
 * The buffer feeds the in-app Diagnostics view (copy-pasteable) and the file
 * is a durable tail the user can `cat` when the window itself is stuck.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
};

const BUFFER_MAX = 800;
const buffer: LogEntry[] = [];
let fileSink: ((line: string) => void) | null = null;

function line(entry: LogEntry): string {
  const data = entry.data ? " " + JSON.stringify(entry.data) : "";
  return `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}${data}`;
}

/** Redact obvious secrets so a pasted report never carries a live token. */
function scrub(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/token|secret|authorization|bearer/i.test(key)) {
      out[key] = typeof value === "string" && value.length > 0 ? `<${value.length} chars>` : value;
    } else if (typeof value === "string") {
      out[key] = scrubText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function scrubText(text: string): string {
  return text.replace(/\b(sess_|sail_|tok_)[A-Za-z0-9_-]+/g, "$1<redacted>");
}

export function log(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message: scrubText(message),
    data: scrub(data),
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  try {
    fileSink?.(line(entry));
  } catch {
    // never let logging break the app
  }
}

export const diag = {
  info: (scope: string, message: string, data?: Record<string, unknown>) => log("info", scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) => log("warn", scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) => log("error", scope, message, data),
};

export function recentLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogs(): void {
  buffer.length = 0;
}

export function configureFileSink(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    fileSink = (l: string) => appendFileSync(path, l + "\n");
    log("info", "diagnostics", "file sink attached", { path });
  } catch (error) {
    log("warn", "diagnostics", "could not attach file sink", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A copy-pasteable text report: header of environment facts, then the tail. */
export function diagnosticsReport(header: Record<string, unknown>): string {
  const headerLines = Object.entries(scrub(header) ?? {}).map(([k, v]) => `${k}: ${stringify(v)}`);
  const logLines = buffer.map(line);
  return [
    "=== Mast diagnostics ===",
    ...headerLines,
    `log entries: ${buffer.length}`,
    "",
    ...logLines,
  ].join("\n");
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
