import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Check, Cross } from "../components/icons";
import {
  aggregateDeletes,
  humanBytes,
  transferPercent,
  upsertTransfer,
  type Transfer,
} from "./transfers";

/**
 * A bottom-right tray of live file transfers, fed by the Rust `transfer` event.
 * On a high-latency link this is the difference between "is it stuck?" and a
 * calm, visible progress bar. Completed transfers linger briefly then clear.
 */
export function TransfersTray() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const unlisten = listen<Transfer>("transfer", (event) => {
      const t = event.payload;
      setTransfers((prev) => upsertTransfer(prev, t));
      // Deletes clear as one batch (below) so the aggregated "N items" row does
      // not shrink as individual files finish; only up/downloads self-clear here.
      if (t.kind !== "delete" && t.status !== "active") {
        clearTimeout(timers.get(t.id));
        timers.set(
          t.id,
          setTimeout(() => setTransfers((prev) => prev.filter((x) => x.id !== t.id)), 4000),
        );
      }
    });
    return () => {
      void unlisten.then((off) => off());
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  // Clear the whole delete batch together, 4s after the last one settles.
  useEffect(() => {
    const deletes = transfers.filter((t) => t.kind === "delete");
    if (deletes.length === 0 || deletes.some((t) => t.status === "active")) return;
    const timer = setTimeout(
      () => setTransfers((prev) => prev.filter((t) => t.kind !== "delete")),
      4000,
    );
    return () => clearTimeout(timer);
  }, [transfers]);

  const others = transfers.filter((t) => t.kind !== "delete");
  const deleteBatch = aggregateDeletes(transfers);
  if (others.length === 0 && !deleteBatch) return null;

  return (
    <div className="transfers" role="status" aria-live="polite">
      {others.map((t) => (
        <TransferRow key={t.id} t={t} />
      ))}
      {deleteBatch && <TransferRow key="delete-batch" t={deleteBatch} />}
    </div>
  );
}

function TransferRow({ t }: { t: Transfer }) {
  const pct = Math.round(transferPercent(t) * 100);
  // A delete has no byte/file totals to measure against, so its bar is a moving
  // indeterminate sweep rather than a fill.
  const indeterminate = t.status === "active" && t.bytesTotal === 0 && t.filesTotal === 0;
  const verb = t.kind === "upload" ? "Uploading" : t.kind === "download" ? "Downloading" : "Deleting";
  return (
    <div className={`transfer transfer--${t.status} transfer--${t.kind}`} data-testid="transfer">
      <div className="transfer__head">
        <span className="transfer__label" title={t.label}>
          {t.label}
        </span>
        <span className="transfer__status">
          {t.status === "done" ? (
            <Check size={13} />
          ) : t.status === "error" ? (
            <Cross size={13} />
          ) : indeterminate ? null : (
            `${pct}%`
          )}
        </span>
      </div>
      <div className="transfer__bar">
        <div
          className={`transfer__fill${indeterminate ? " transfer__fill--indeterminate" : ""}`}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="transfer__meta">
        {t.status === "error"
          ? (t.detail ?? "failed")
          : t.kind === "delete"
            ? t.status === "done"
              ? t.filesTotal > 1
                ? `Removed ${t.filesTotal} items`
                : "Removed"
              : t.filesTotal > 1
                ? `Removing ${t.filesDone}/${t.filesTotal}…`
                : "Removing…"
            : `${verb} · ${t.filesDone}/${t.filesTotal} files · ${humanBytes(t.bytesDone)}${
                t.bytesTotal > 0 ? ` / ${humanBytes(t.bytesTotal)}` : ""
              }`}
      </div>
    </div>
  );
}
