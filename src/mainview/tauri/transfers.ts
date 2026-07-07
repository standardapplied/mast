/**
 * Transfer progress model — one entry per upload/download, fed by the Rust
 * `transfer` event. Pure helpers so the aggregation/formatting is testable.
 */

export type Transfer = {
  id: string;
  kind: "upload" | "download" | "delete";
  label: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  status: "active" | "done" | "error";
  detail?: string;
};

/** Replace the entry with the same id, or append — preserving order. */
export function upsertTransfer(list: Transfer[], t: Transfer): Transfer[] {
  const index = list.findIndex((x) => x.id === t.id);
  if (index === -1) return [...list, t];
  const next = list.slice();
  next[index] = t;
  return next;
}

/** Completion fraction (0..1) — by bytes when known, else by file count. */
export function transferPercent(t: Transfer): number {
  if (t.status === "done") return 1;
  if (t.bytesTotal > 0) return Math.min(1, t.bytesDone / t.bytesTotal);
  if (t.filesTotal > 0) return Math.min(1, t.filesDone / t.filesTotal);
  return 0;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
