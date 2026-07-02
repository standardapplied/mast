import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { Person } from "./icons";
import { ToggleButton } from "./ToggleButton";
import { Button } from "./ui";
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
  onLogin,
}: {
  theme: ThemeController;
  server?: string;
  onLogin?: () => void;
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
            <span className="user-menu-name">Not signed in</span>
            {server && <span className="user-menu-detail">{server}</span>}
          </div>

          <div className="user-menu-section">
            <span className="eyebrow">Theme</span>
            <ToggleButton options={THEME_OPTIONS} value={mode} onChange={setTheme} />
          </div>

          <div className="user-menu-section">
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
          </div>
        </div>
      )}
    </div>
  );
}
