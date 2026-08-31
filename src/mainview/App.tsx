import { useEffect, useState, type ReactNode, useRef } from "react";
import type { ConnectionStatus, WhoAmI } from "../shared/sail-models";
import { BoardScreen } from "./board/BoardScreen";
import { notification } from "./board/notifyPolicy";
import { connectPresence, presenceStore } from "./board/presenceStore";
import { RoomsScreen } from "./board/RoomsScreen";
import { SpecDetail } from "./board/SpecDetail";
import { Diagnostics } from "./components/Diagnostics";
import { cx } from "./components/cx";
import { Board, Logo, Rooms, Terminal } from "./components/icons";
import { LoadingMark } from "./components/Loading";
import { ToastProvider, useToast } from "./components/Toast";
import { Tooltip } from "./components/Tooltip";
import { Button } from "./components/ui";
import { UserMenu } from "./components/UserMenu";
import type { Gateway } from "./gateway";
import type { DeckServices } from "./terminal/roomDeck";
import type { ThemeController } from "./theme";
import type { Updater } from "./updater";

type AppView = "rooms" | "board" | "terminal";

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

/**
 * Bridges the event stream to toasts through the pure notification policy:
 * needs-reply and run-endings page the human, the focused room stays quiet.
 */
function Notifier({
  gateway,
  focusedSpecId,
}: {
  gateway: Gateway;
  focusedSpecId: string | null;
}) {
  const { showToast } = useToast();
  const engaged = useRef<Set<string>>(new Set());
  useEffect(() => {
    void gateway.listSpecs({}).then((result) => {
      if (!result.ok) return;
      for (const spec of result.value.specs) {
        if (spec.engagement) engaged.current.add(spec.id);
      }
    });
  }, [gateway]);
  useEffect(
    () =>
      gateway.onEvent((event) => {
        if (event.spec && event.type === "spec_engaged") engaged.current.add(event.spec);
        if (event.spec && event.type === "spec_disengaged") engaged.current.delete(event.spec);
        const decision = notification(event, focusedSpecId, (id) => engaged.current.has(id));
        if (decision) showToast(decision.tone, decision.message);
      }),
    [gateway, focusedSpecId, showToast],
  );
  return null;
}

export function App({
  gateway,
  theme,
  terminal,
  deck,
  updater,
}: {
  gateway: Gateway;
  theme: ThemeController;
  /** The terminal section, injected by the Tauri entry (absent in demo/tests). */
  terminal?: ReactNode;
  /** The room deck's terminal edge, injected by the Tauri entry (absent in demo/tests). */
  deck?: DeckServices;
  /** Auto-updater, injected by the Tauri entry (absent on demo/tests). */
  updater?: Updater;
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [everReady, setEverReady] = useState(false);
  const [specId, setSpecId] = useState<string | null>(specIdFromHash(location.hash));
  const [view, setView] = useState<AppView>(() => specId ? "board" : "rooms");
  // Mount the terminal on first visit and keep it alive (hidden) thereafter, so
  // switching to the board and back doesn't tear down the shell session.
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [identity, setIdentity] = useState<WhoAmI | null>(null);
  const [roomFocus, setRoomFocus] = useState<string | null>(null);

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

  // Presence rides the app-wide event stream — no polling. One runs listing on
  // connect seeds chips for agents already mid-work (or mid-silence); after
  // that, progress and agent_presence events keep the store live.
  useEffect(() => {
    if (!ready) return;
    return connectPresence(gateway, presenceStore);
  }, [gateway, ready]);

  useEffect(() => {
    const onHashChange = () => {
      const next = specIdFromHash(location.hash);
      setSpecId(next);
      if (next) setView("board");
    };
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
  const goRooms = () => {
    setView("rooms");
    location.hash = "#/";
    setSpecId(null);
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

  const focusedSpecId =
    view === "rooms" ? roomFocus : view === "board" ? specId : null;

  // The workspace renders once we've ever been ready — transient degradation keeps the
  // last view (pill carries the truth) instead of yanking it to a full-screen
  // error. Only a genuinely unusable state takes over the whole surface:
  // unauthenticated (needs sign-in), or first-connect probing/failure.
  const needsLogin = status?.phase === "unauthenticated";
  const firstConnectBlocking =
    !everReady && (!status || status.phase !== "ready");
  const showWorkspace = !needsLogin && !firstConnectBlocking;
  const connectGate =
    status && (needsLogin || status.phase === "no-host" || status.phase === "failed") ? (
      <ConnectScreen
        status={status}
        onLogin={() => void login()}
        busy={loginBusy}
        loginError={loginError}
      />
    ) : (
      <LoadingMark
        label={
          status?.phase === "tunnel-connecting" ? "Opening the tunnel" : "Finding the control plane"
        }
      />
    );

  const navItems = [
    { value: "rooms" as const, label: "Rooms", Icon: Rooms, go: goRooms },
    { value: "board" as const, label: "Board", Icon: Board, go: goBoard },
    ...(terminal
      ? [{ value: "terminal" as const, label: "Terminal", Icon: Terminal, go: goTerminal }]
      : []),
  ];

  // The connection state earns UI only when it needs attention: a thin banner
  // appears while the workspace is up but the link is degraded. A healthy link
  // shows nothing — no standing indicator competing for the eye.
  const degraded = showWorkspace && !!status && status.phase !== "ready";

  return (
    <ToastProvider>
      {ready && <Notifier gateway={gateway} focusedSpecId={focusedSpecId} />}
      <div className="cockpit">
        {/* One Slack-style chrome band across the whole window: it is the drag surface (double-
            click zooms, via the window's drag-region handler), it insets for the macOS traffic
            lights, and its content is the active view's — the terminal parks its project tabs
            here through the #topbar-slot portal; other views show their context. */}
        {/* "deep" arms every non-interactive pixel of the band as a drag/zoom surface — buttons,
            links, and role="tab" elements block it themselves, so a tab-filled band still drags
            from its gaps (bare attrs only arm direct hits and go dead once children cover them). */}
        <header className="topbar" data-tauri-drag-region="deep">
          <div className="topbar__inset" aria-hidden />
          <div
            id="topbar-slot"
            className="topbar__slot"
            style={{ display: view === "terminal" ? "flex" : "none" }}
          />
          {view !== "terminal" && (
            <div className="topbar__context">
              {showWorkspace ? (navItems.find((item) => item.value === view)?.label ?? "Mast") : "Mast"}
            </div>
          )}
        </header>
        <div className="cockpit-body">
        <nav className="rail" aria-label="Sections" data-tauri-drag-region="deep">
          <button type="button" className="rail-brand" onClick={goRooms} aria-label="Mast — rooms">
            <Logo size={22} />
          </button>
          <div className="rail-nav">
            {navItems.map((item) => (
              <Tooltip key={item.value} content={item.label} side="right">
                <button
                  type="button"
                  className={cx("rail-item", view === item.value && "is-active")}
                  data-testid={`nav-${item.value}`}
                  aria-label={item.label}
                  aria-current={view === item.value ? "page" : undefined}
                  onClick={item.go}
                >
                  <item.Icon size={20} />
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="rail-spacer" />
          <div className="rail-user">
            <UserMenu
              theme={theme}
              tokenKind={status?.tokenKind}
              identity={identity}
              updater={updater}
              onLogin={() => void login()}
              onLogout={() => void logout()}
              onDiagnostics={() => setShowDiagnostics(true)}
            />
          </div>
        </nav>
        {/* Workspace views stay mounted once ready and hide via display:none — the
            terminal's session-preserving pattern applied to rooms and board, so a
            tab switch never cold-boots the view it left. */}
        <main className="cockpit-main">
          <section
            className="cockpit-view"
            data-testid="view-rooms"
            style={{ display: view === "rooms" ? "flex" : "none" }}
          >
            {!showWorkspace ? (
              view === "rooms" && connectGate
            ) : (
              <RoomsScreen gateway={gateway} deck={deck} active={view === "rooms"} onFocus={setRoomFocus} />
            )}
          </section>
          <section
            className="cockpit-view"
            data-testid="view-board"
            style={{ display: view === "board" ? "flex" : "none" }}
          >
            {!showWorkspace ? (
              view === "board" && connectGate
            ) : specId ? (
              <SpecDetail gateway={gateway} specId={specId} onOpenSpec={openSpec} onBack={backToBoard} deck={deck} active={view === "board"} />
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
        </div>
        {degraded && (
          <div className="connection-banner" role="status" data-state={pillView.state}>
            {pillView.label}
            {status?.detail ? ` — ${status.detail}` : ""}
          </div>
        )}
        {showDiagnostics && <Diagnostics gateway={gateway} onClose={() => setShowDiagnostics(false)} />}
      </div>
    </ToastProvider>
  );
}
