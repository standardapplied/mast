import { useEffect, useState, type ReactNode } from "react";
import type { ConnectionStatus, WhoAmI } from "../shared/sail-models";
import type { BridgeStatus } from "../shared/types";
import { BoardScreen } from "./board/BoardScreen";
import { SpecDetail } from "./board/SpecDetail";
import { Diagnostics } from "./components/Diagnostics";
import { Logo } from "./components/icons";
import { LoadingMark } from "./components/Loading";
import { ToastProvider } from "./components/Toast";
import { ToggleButton } from "./components/ToggleButton";
import { Button, Eyebrow } from "./components/ui";
import { UserMenu } from "./components/UserMenu";
import type { Gateway } from "./gateway";
import { onPush } from "./push";
import type { ThemeController } from "./theme";
import type { Updater } from "./updater";

const NAV_OPTIONS = [
  { value: "board", label: "Board" },
  { value: "terminal", label: "Terminal" },
];

function pill(status: ConnectionStatus): { label: string; state: string } {
  switch (status.phase) {
    case "ready":
      return status.stream === "connected"
        ? { label: "Live", state: "connected" }
        : { label: "Reconnecting…", state: "reconnecting" };
    case "probing":
    case "tunnel-connecting":
      return { label: "Connecting…", state: "connecting" };
    case "tunnel-degraded":
      return { label: "Reconnecting…", state: "reconnecting" };
    case "unauthenticated":
      return { label: "Signed out", state: "disconnected" };
    default:
      return { label: "Offline", state: "disconnected" };
  }
}

function ConnectScreen({
  status,
  onLogin,
  busy,
  loginError,
}: {
  status: ConnectionStatus;
  onLogin: () => void;
  busy: boolean;
  loginError: string | null;
}) {
  return (
    <div className="connect-screen" data-testid="connect-screen">
      <Logo size={40} />
      <h1 className="connect-title">
        {status.phase === "unauthenticated" ? "Sign in to Sail" : "Can’t reach the control plane"}
      </h1>
      {status.phase !== "unauthenticated" && (
        <p className="connect-detail">{status.detail ?? `Nothing answered at ${status.server}.`}</p>
      )}
      {status.phase === "unauthenticated" ? (
        <Button onClick={onLogin} disabled={busy} data-testid="connect-login">
          {busy ? "Waiting for Touch ID…" : "Sign in with passkey"}
        </Button>
      ) : (
        <p className="connect-detail">
          Check <code>host:</code> and <code>server:</code> in <code>~/.sail/config.yaml</code>.
        </p>
      )}
      {loginError && <p className="connect-error">{loginError}</p>}
    </div>
  );
}

function specIdFromHash(hash: string): string | null {
  const match = hash.match(/^#\/spec\/(.+)$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function App({
  gateway,
  theme,
  terminal,
  updater,
}: {
  gateway: Gateway;
  theme: ThemeController;
  /** The terminal section, injected by the Tauri entry (absent on Electrobun/demo). */
  terminal?: ReactNode;
  /** Auto-updater, injected by the Tauri entry (absent on demo/tests). */
  updater?: Updater;
}) {
  const [bridge, setBridge] = useState<BridgeStatus>("connected");
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [everReady, setEverReady] = useState(false);
  const [specId, setSpecId] = useState<string | null>(specIdFromHash(location.hash));
  const [view, setView] = useState<"board" | "terminal">("board");
  // Mount the terminal on first visit and keep it alive (hidden) thereafter, so
  // switching to the board and back doesn't tear down the shell session.
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [identity, setIdentity] = useState<WhoAmI | null>(null);

  useEffect(() => onPush("bridge-status", ({ status: s }) => setBridge(s)), []);
  useEffect(
    () =>
      gateway.onConnectionStatus((next) => {
        setStatus(next);
        if (next.phase === "ready") setEverReady(true);
      }),
    [gateway],
  );
  useEffect(() => {
    // The one-shot snapshot only seeds the first render — a later push always
    // wins, so a stale snapshot resolving late can never clobber it.
    void gateway.connection().then((snapshot) => {
      setStatus((current) => current ?? snapshot);
      if (snapshot.phase === "ready") setEverReady(true);
    });
  }, [gateway]);

  // Load the caller's identity once the connection is live, and drop it the
  // moment it isn't (logout → unauthenticated), so the menu never shows a stale
  // name. Refetched automatically when a login flips the phase back to ready.
  const ready = status?.phase === "ready";
  useEffect(() => {
    if (!ready) return void setIdentity(null);
    void gateway.whoami().then((r) => setIdentity(r.ok ? r.value : null));
  }, [gateway, ready]);

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

  const goBoard = () => {
    setView("board");
    backToBoard();
  };
  const goTerminal = () => {
    setTerminalOpened(true);
    setView("terminal");
  };

  const refreshStatus = () => void gateway.connection().then(setStatus);

  const login = async () => {
    setLoginBusy(true);
    setLoginError(null);
    const result = await gateway.login();
    setLoginBusy(false);
    if (result.ok) refreshStatus();
    else setLoginError(result.detail ?? "Sign-in failed.");
  };

  const logout = async () => {
    await gateway.logout();
    refreshStatus();
  };

  const pillView = status ? pill(status) : { label: "Connecting…", state: "connecting" };

  // Board renders once we've ever been ready — transient degradation keeps the
  // last view (pill carries the truth) instead of yanking it to a full-screen
  // error. Only a genuinely unusable state takes over the whole surface:
  // unauthenticated (needs sign-in), or first-connect probing/failure.
  const needsLogin = status?.phase === "unauthenticated";
  const firstConnectBlocking =
    !everReady && (!status || status.phase !== "ready");
  const showBoard = !needsLogin && !firstConnectBlocking;

  return (
    <ToastProvider>
      <div className="cockpit">
        <header className="toolbar cockpit-toolbar electrobun-webkit-app-region-drag">
          <button
            type="button"
            className="cockpit-brand electrobun-webkit-app-region-no-drag"
            onClick={goBoard}
          >
            <Logo size={20} />
            <span className="cockpit-wordmark">Mast</span>
          </button>
          {terminal && (
            <span className="cockpit-nav electrobun-webkit-app-region-no-drag">
              <ToggleButton
                options={NAV_OPTIONS}
                value={view}
                onChange={(v) => (v === "terminal" ? goTerminal() : goBoard())}
              />
            </span>
          )}
          <span className="cockpit-toolbar-spacer" />
          <span className="stream-pill" data-state={pillView.state} title={status?.detail ?? "Connection"}>
            {pillView.label}
          </span>
          {bridge !== "connected" && (
            <span className="stream-pill" data-state="reconnecting" data-testid="bridge-status">
              {bridge === "reconnecting" ? "Recovering…" : "Unresponsive"}
            </span>
          )}
          <span className="electrobun-webkit-app-region-no-drag">
            <UserMenu
              theme={theme}
              tokenKind={status?.tokenKind}
              identity={identity}
              updater={updater}
              onLogin={() => void login()}
              onLogout={() => void logout()}
              onDiagnostics={() => setShowDiagnostics(true)}
            />
          </span>
        </header>
        <main className="cockpit-main">
          <section className="cockpit-view" style={{ display: view === "board" ? "flex" : "none" }}>
            {!showBoard ? (
              status && (needsLogin || status.phase === "no-host" || status.phase === "failed") ? (
                <ConnectScreen status={status} onLogin={() => void login()} busy={loginBusy} loginError={loginError} />
              ) : (
                <LoadingMark label={status?.phase === "tunnel-connecting" ? "Opening the tunnel" : "Finding the control plane"} />
              )
            ) : specId ? (
              <SpecDetail gateway={gateway} specId={specId} onOpenSpec={openSpec} onBack={backToBoard} />
            ) : (
              <BoardScreen
                gateway={gateway}
                onOpenSpec={openSpec}
                server={status?.server}
                tokenPresent={status?.tokenPresent ?? true}
              />
            )}
          </section>
          {terminal && terminalOpened && (
            <section className="cockpit-view" style={{ display: view === "terminal" ? "flex" : "none" }}>
              {terminal}
            </section>
          )}
        </main>
        {showDiagnostics && <Diagnostics gateway={gateway} onClose={() => setShowDiagnostics(false)} />}
      </div>
    </ToastProvider>
  );
}
