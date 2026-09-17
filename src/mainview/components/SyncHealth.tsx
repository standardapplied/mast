import { useEffect, useState } from "react";
import type { SyncStatus } from "../../shared/sail-models";
import type { Gateway } from "../gateway";

export function useSyncStatus(gateway: Gateway, ready: boolean): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!ready) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await gateway.syncStatus();
        if (live && result.ok) setStatus(result.value);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 15_000);
    const unsubscribe = gateway.onEvent((event) => {
      if (event.type === "sync_degraded" || event.type === "sync_recovered") void refresh();
    });
    return () => {
      live = false;
      clearInterval(interval);
      unsubscribe();
    };
  }, [gateway, ready]);
  return status;
}

function age(since: string | null | undefined, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(since ?? "")) / 1000);
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return "just now";
}

export function SyncHealthChip({ status, now = Date.now() }: {
  status: SyncStatus | null;
  now?: number;
}) {
  if (!status?.state) return null;
  const stale = status.state === "stale";
  const syncing = status.state === "syncing";
  const reason = status.last_error ?? "Sync failed";
  const label = stale
    ? `stale since ${age(status.stale_since ?? status.last_success_at ?? status.last_attempt_at, now)} — ${reason}`
    : syncing ? "syncing" : "in sync";
  const title = stale ? reason : `${syncing ? "Syncing" : "In sync"}${status.main ? ` with ${status.main}` : ""}`;
  return (
    <span
      className={`badge sync-health ${stale ? "badge-warning" : syncing ? "badge-info" : "badge-success"}`}
      role="status"
      title={title}
      data-sync-state={status.state}
    >
      {label}
    </span>
  );
}
