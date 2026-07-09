/**
 * A tiny in-memory ring of recent runtime errors (failed API calls, updater
 * checks, …). It exists so the Diagnostics report can show *why* something broke
 * — a bad HTTP status or a network failure that otherwise disappears into a
 * generic "couldn't do that" in the UI. Bounded so it never grows unbounded.
 */

export type LoggedError = { ts: number; source: string; message: string };

const MAX = 50;
const entries: LoggedError[] = [];

export function logError(source: string, message: string): void {
  entries.push({ ts: Date.now(), source, message });
  if (entries.length > MAX) entries.shift();
}

export function recentErrors(): LoggedError[] {
  return entries.slice();
}

export function formatRecentErrors(): string {
  if (entries.length === 0) return "(no recent errors)";
  return entries
    .map((e) => `${new Date(e.ts).toISOString()}  [${e.source}]  ${e.message}`)
    .join("\n");
}

export function clearErrors(): void {
  entries.length = 0;
}
