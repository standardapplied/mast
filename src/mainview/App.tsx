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
    <main className="app-shell">
      <h1 className="app-title">Mast</h1>
      <p className="app-tagline">Isolated development environments for AI agents.</p>
      <span className="bridge-badge" data-testid="bridge-status" data-status={bridge}>
        {STATUS_LABEL[bridge]}
      </span>
    </main>
  );
}
