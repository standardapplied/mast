import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Check, Cross } from "../components/icons";
import { humanBytes, transferPercent, upsertTransfer, type Transfer } from "./transfers";

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
      if (t.status !== "active") {
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

  if (transfers.length === 0) return null;

  return (
    <div className="transfers" role="status" aria-live="polite">
      {transfers.map((t) => (
        <TransferRow key={t.id} t={t} />
      ))}
    </div>
  );
}

function TransferRow({ t }: { t: Transfer }) {
  const pct = Math.round(transferPercent(t) * 100);
  const verb = t.kind === "upload" ? "Uploading" : "Downloading";
  return (
    <div className={`transfer transfer--${t.status}`} data-testid="transfer">
      <div className="transfer__head">
        <span className="transfer__label" title={t.label}>
          {t.label}
        </span>
        <span className="transfer__status">
          {t.status === "done" ? (
            <Check size={13} />
          ) : t.status === "error" ? (
            <Cross size={13} />
          ) : (
            `${pct}%`
          )}
        </span>
      </div>
      <div className="transfer__bar">
        <div className="transfer__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="transfer__meta">
        {t.status === "error"
          ? (t.detail ?? "failed")
          : `${verb} · ${t.filesDone}/${t.filesTotal} files · ${humanBytes(t.bytesDone)}${
              t.bytesTotal > 0 ? ` / ${humanBytes(t.bytesTotal)}` : ""
            }`}
      </div>
    </div>
  );
}
