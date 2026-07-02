import { useEffect, useState } from "react";
import type { EventStreamState } from "../shared/sail-models";
import type { BridgeStatus } from "../shared/types";
import { BoardScreen } from "./board/BoardScreen";
import { SpecDetail } from "./board/SpecDetail";
import { Logo } from "./components/icons";
import { ToastProvider } from "./components/Toast";
import { UserMenu } from "./components/UserMenu";
import type { Gateway } from "./gateway";
import { onPush } from "./push";
import type { ThemeController } from "./theme";

const STREAM_LABEL: Record<EventStreamState, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  disconnected: "Offline",
};

function specIdFromHash(hash: string): string | null {
  const match = hash.match(/^#\/spec\/(.+)$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function App({ gateway, theme }: { gateway: Gateway; theme: ThemeController }) {
  const [bridge, setBridge] = useState<BridgeStatus>("connected");
  const [stream, setStream] = useState<EventStreamState>("disconnected");
  const [server, setServer] = useState<string | undefined>(undefined);
  const [specId, setSpecId] = useState<string | null>(specIdFromHash(location.hash));

  useEffect(() => onPush("bridge-status", ({ status }) => setBridge(status)), []);
  useEffect(() => gateway.onStreamState(setStream), [gateway]);
  useEffect(() => {
    void gateway.connection().then(({ server: url }) => setServer(url));
  }, [gateway]);

  useEffect(() => {
    const onHashChange = () => setSpecId(specIdFromHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openSpec = (id: string) => {
    location.hash = `#/spec/${encodeURIComponent(id)}`;
    setSpecId(id);
  };
  const backToBoard = () => {
    location.hash = "#/";
    setSpecId(null);
  };

  return (
    <ToastProvider>
      <div className="cockpit">
        <header className="toolbar cockpit-toolbar electrobun-webkit-app-region-drag">
          <button
            type="button"
            className="cockpit-brand electrobun-webkit-app-region-no-drag"
            onClick={backToBoard}
          >
            <Logo size={20} />
            <span className="cockpit-wordmark">Mast</span>
          </button>
          <span className="cockpit-toolbar-spacer" />
          <span className="stream-pill" data-state={stream} title="Control-plane event stream">
            {STREAM_LABEL[stream]}
          </span>
          {bridge !== "connected" && (
            <span className="stream-pill" data-state="reconnecting" data-testid="bridge-status">
              {bridge === "reconnecting" ? "Recovering…" : "Unresponsive"}
            </span>
          )}
          <span className="electrobun-webkit-app-region-no-drag">
            <UserMenu theme={theme} server={server} />
          </span>
        </header>
        <main className="cockpit-main">
          {specId ? (
            <SpecDetail gateway={gateway} specId={specId} onOpenSpec={openSpec} onBack={backToBoard} />
          ) : (
            <BoardScreen gateway={gateway} onOpenSpec={openSpec} server={server} />
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
