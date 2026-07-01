import { useEffect, useState } from "react";
import type { BridgeStatus } from "../shared/types";
import { onPush } from "./push";

const STATUS_LABEL: Record<BridgeStatus, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function App() {
  const [bridge, setBridge] = useState<BridgeStatus>("connected");

  useEffect(() => onPush("bridge-status", ({ status }) => setBridge(status)), []);

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-bg text-content">
      <h1 className="text-2xl font-semibold tracking-tight">Mast</h1>
      <p className="text-sm text-muted">Isolated development environments for AI agents.</p>
      <span
        className="rounded-full border border-border px-3 py-1 text-xs text-muted"
        data-testid="bridge-status"
        data-status={bridge}
      >
        {STATUS_LABEL[bridge]}
      </span>
    </main>
  );
}
