import { useEffect, useRef, useState } from "react";
import type { WhoAmI } from "../../shared/sail-models";
import { cx } from "./cx";
import { Person } from "./icons";
import { ToggleButton } from "./ToggleButton";
import { Badge, Button } from "./ui";
import type { ThemeController, ThemeMode } from "../theme";

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
  server,
  tokenKind = "none",
  identity,
  onLogin,
  onLogout,
  onDiagnostics,
}: {
  theme: ThemeController;
  server?: string;
  tokenKind?: "session" | "api" | "none";
  identity?: WhoAmI | null;
  onLogin?: () => void;
  onLogout?: () => void;
  onDiagnostics?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(theme.mode());
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const setTheme = (value: string) => {
    theme.setMode(value as ThemeMode);
    setMode(value as ThemeMode);
  };

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        type="button"
        className={cx("user-menu-trigger", isOpen && "is-open")}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Account"
        data-testid="user-menu-trigger"
      >
        <Person size={15} />
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
                <Badge tone={identity.role === "admin" ? "success" : "neutral"}>{identity.role}</Badge>
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
            {server && <span className="user-menu-detail user-menu-server">{server}</span>}
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
        </div>
      )}
    </div>
  );
}
