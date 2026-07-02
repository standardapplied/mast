import { useEffect, useState } from "react";
import type { EventStreamState } from "../shared/sail-models";
import type { BridgeStatus } from "../shared/types";
import { BoardScreen } from "./board/BoardScreen";
import { SpecDetail } from "./board/SpecDetail";
import { Logo, Moon, Person, Sun } from "./components/icons";
import { ToastProvider } from "./components/Toast";
import type { Gateway } from "./gateway";
import { onPush } from "./push";
import type { ThemeController, ThemeMode } from "./theme";

const BRIDGE_LABEL: Record<BridgeStatus, string> = {
  connected: "Bridge",
  reconnecting: "Bridge reconnecting…",
  disconnected: "Bridge down",
};

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

const NEXT_MODE: Record<ThemeMode, ThemeMode> = { light: "dark", dark: "system", system: "light" };

export function App({ gateway, theme }: { gateway: Gateway; theme: ThemeController }) {
  const [bridge, setBridge] = useState<BridgeStatus>("connected");
  const [stream, setStream] = useState<EventStreamState>("disconnected");
  const [specId, setSpecId] = useState<string | null>(specIdFromHash(location.hash));
  const [themeMode, setThemeMode] = useState<ThemeMode>(theme.mode());

  const cycleTheme = () => {
    const next = NEXT_MODE[themeMode];
    theme.setMode(next);
    setThemeMode(next);
  };

  useEffect(() => onPush("bridge-status", ({ status }) => setBridge(status)), []);
  useEffect(() => gateway.onStreamState(setStream), [gateway]);

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
        <header className="toolbar cockpit-toolbar">
          <button type="button" className="cockpit-brand" onClick={backToBoard}>
            <Logo size={20} />
            <span className="cockpit-wordmark">Mast</span>
          </button>
          <span className="cockpit-toolbar-spacer" />
          <span className="stream-pill" data-state={stream}>
            {STREAM_LABEL[stream]}
          </span>
          <span
            className="bridge-badge"
            data-testid="bridge-status"
            data-status={bridge}
            title={BRIDGE_LABEL[bridge]}
          >
            {BRIDGE_LABEL[bridge]}
          </span>
          <button
            type="button"
            className="toolbar-icon-btn"
            onClick={cycleTheme}
            title={`Theme: ${themeMode} — click to switch`}
            data-testid="theme-toggle"
          >
            {theme.resolved() === "dark" ? <Moon size={15} /> : <Sun size={15} />}
            {themeMode === "system" && <span className="toolbar-icon-note">auto</span>}
          </button>
          <button
            type="button"
            className="toolbar-icon-btn"
            title="Sign in with a passkey — lands with the cockpit shell"
            disabled
          >
            <Person size={15} />
          </button>
        </header>
        <main className="cockpit-main">
          {specId ? (
            <SpecDetail gateway={gateway} specId={specId} onOpenSpec={openSpec} onBack={backToBoard} />
          ) : (
            <BoardScreen gateway={gateway} onOpenSpec={openSpec} />
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
