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

/** Bulk downloads land every item at ~/Downloads/<name>: two selected items
 *  sharing a name (case-insensitively — macOS' default filesystem is) would
 *  silently clobber each other. Returns the first colliding name, or null. */
export function duplicateDownloadName(names: string[]): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return null;
}

/**
 * Collapse every in-flight delete into a single synthetic row, so removing N
 * files reads as one "N items" progress entry instead of N separate rows.
 * Uploads/downloads stay per-transfer. Returns null when nothing is deleting.
 */
export function aggregateDeletes(list: Transfer[]): Transfer | null {
  const deletes = list.filter((t) => t.kind === "delete");
  if (deletes.length === 0) return null;
  const failed = deletes.filter((t) => t.status === "error").length;
  const settled = deletes.filter((t) => t.status !== "active").length;
  const active = settled < deletes.length;
  const total = deletes.length;
  return {
    id: "delete-batch",
    kind: "delete",
    label: total === 1 ? deletes[0].label : `${total} items`,
    filesDone: settled,
    filesTotal: total,
    bytesDone: 0,
    bytesTotal: 0,
    status: active ? "active" : failed > 0 ? "error" : "done",
    detail: failed > 0 ? `${failed} failed` : undefined,
  };
}

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
