import { useEffect, useRef, useState } from "react";
import type { WhoAmI } from "../../shared/sail-models";
import { cx } from "./cx";
import { Person } from "./icons";
import { ToggleButton } from "./ToggleButton";
import { Button } from "./ui";
import type { ThemeController, ThemeMode } from "../theme";
import { useUpdater, type Updater, type UpdaterView } from "../updater";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

/**
 * Top-right user menu ported from light-grid-wapp: avatar trigger, outside
 * click to close, theme toggle inside. Identity is a placeholder until the
 * passkey ceremony lands with mast-cockpit-shell.
 */
export function UserMenu({
  theme,
  tokenKind = "none",
  identity,
  updater,
  onLogin,
  onLogout,
  onDiagnostics,
}: {
  theme: ThemeController;
  tokenKind?: "session" | "api" | "none";
  identity?: WhoAmI | null;
  updater?: Updater;
  onLogin?: () => void;
  onLogout?: () => void;
  onDiagnostics?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(theme.mode());
  const menuRef = useRef<HTMLDivElement>(null);
  const upd = useUpdater(updater);
  const hasUpdate = upd.phase === "available" || upd.phase === "ready";

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside, true);
    return () => document.removeEventListener("mousedown", handleClickOutside, true);
  }, [isOpen]);

  const setTheme = (value: string) => {
    theme.setMode(value as ThemeMode);
    setMode(value as ThemeMode);
  };

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        type="button"
        className={cx("user-menu-trigger", isOpen && "is-open", hasUpdate && "has-update")}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Account"
        data-testid="user-menu-trigger"
      >
        <Person size={15} />
        {hasUpdate && <span className="user-menu-dot" aria-hidden="true" />}
      </button>

      {isOpen && (
        <div className="user-menu-panel" data-testid="user-menu-panel">
          <div className="user-menu-identity">
            {identity ? (
              <>
                <span className="user-menu-name">
                  {identity.display_name ?? identity.fde ?? identity.name}
                </span>
                <span className="user-menu-detail">{identity.email ?? `@${identity.fde ?? identity.name}`}</span>
                <span className="user-menu-detail user-menu-role">{identity.role}</span>
              </>
            ) : (
              <span className="user-menu-name">
                {tokenKind === "session"
                  ? "Passkey session"
                  : tokenKind === "api"
                    ? "API token"
                    : "Not signed in"}
              </span>
            )}
          </div>

          <div className="user-menu-section">
            <span className="eyebrow">Theme</span>
            <ToggleButton options={THEME_OPTIONS} value={mode} onChange={setTheme} />
          </div>

          <div className="user-menu-section">
            {tokenKind === "none" ? (
              <Button
                variant="ghost"
                className="user-menu-signin"
                disabled={!onLogin}
                onClick={() => {
                  setIsOpen(false);
                  onLogin?.();
                }}
              >
                Sign in with passkey
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="user-menu-signin"
                disabled={!onLogout}
                onClick={() => {
                  setIsOpen(false);
                  onLogout?.();
                }}
                data-testid="user-menu-signout"
              >
                Sign out
              </Button>
            )}
            <Button
              variant="ghost"
              className="user-menu-signin"
              onClick={() => {
                setIsOpen(false);
                onDiagnostics?.();
              }}
              data-testid="open-diagnostics"
            >
              Diagnostics
            </Button>
          </div>

          {upd.enabled && (
            <div className="user-menu-section user-menu-updates">
              <span className="eyebrow">Mast{upd.version ? ` v${upd.version}` : ""}</span>
              <UpdateControl upd={upd} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UpdateControl({ upd }: { upd: UpdaterView }) {
  if (upd.phase === "downloading") {
    return (
      <span className="user-menu-detail" data-testid="update-progress">
        Downloading…{upd.progress != null ? ` ${Math.round(upd.progress * 100)}%` : ""}
      </span>
    );
  }
  if (upd.phase === "ready") {
    return (
      <Button variant="ghost" className="user-menu-signin" onClick={upd.restart} data-testid="update-restart">
        Restart to update
      </Button>
    );
  }
  if (upd.phase === "available") {
    return (
      <Button variant="ghost" className="user-menu-signin" onClick={upd.install} data-testid="update-install">
        Update to v{upd.available}
      </Button>
    );
  }
  if (upd.phase === "error") {
    return (
      <>
        <Button variant="ghost" className="user-menu-signin" onClick={upd.check}>
          Couldn’t check — retry
        </Button>
        <Button variant="ghost" className="user-menu-signin" onClick={upd.openReleases}>
          Open releases page
        </Button>
      </>
    );
  }
  return (
    <Button
      variant="ghost"
      className="user-menu-signin"
      disabled={upd.phase === "checking"}
      onClick={upd.check}
      data-testid="update-check"
    >
      {upd.phase === "checking"
        ? "Checking…"
        : upd.phase === "current"
          ? "You’re on the latest"
          : "Check for updates"}
    </Button>
  );
}
