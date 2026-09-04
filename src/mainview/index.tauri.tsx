import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CrashScreen } from "./components/CrashScreen";
import { logError } from "./errorLog";
import { Styleguide } from "./styleguide";
import { createTauriGateway } from "./tauri/gateway";
import type { RosterSources } from "./tauri/projectRoster";
import { tauriDeckServices } from "./tauri/RoomWorkbench";
import { TerminalWorkspace } from "./tauri/TerminalWorkspace";
import { createTauriUpdater } from "./tauri/updater";
import { browserThemeDeps, createThemeController } from "./theme";

/**
 * The webview entry: the React app backed by the Rust `invoke` gateway, which
 * runs the SSH stack in-process. Transport lives behind `./tauri/`, so this
 * bundle stays portable to iOS/Android.
 */

document.documentElement.classList.add("in-shell");
// The window runs a transparent titlebar (titleBarStyle Overlay): content owns the top strip and
// the traffic lights float over the topbar's inset — CSS keyed on this flag makes room for them.
document.body.dataset.chrome = "overlay";

// A desktop app never shows the webview's own context menu ("Reload"). Two carve-outs keep the
// useful native menus: editable fields (spellcheck, clipboard) and any live text selection
// (Copy / Look Up on read-only text — spec bodies, transcripts, diagnostics — where no app menu
// exists). The terminal is unaffected: its selection is canvas-drawn, never a DOM selection.
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  if (window.getSelection()?.toString()) return;
  e.preventDefault();
});

// The traffic lights auto-hide in macOS fullscreen; mirror that into a body flag so the topbar's
// light inset collapses with them.
const syncFullscreen = () => {
  void getCurrentWindow()
    .isFullscreen()
    .then((fs) => {
      document.body.dataset.fullscreen = fs ? "true" : "false";
    })
    .catch(() => {});
};
syncFullscreen();
void getCurrentWindow().onResized(syncFullscreen);

const gateway = createTauriGateway();
const rosterSources: RosterSources = {
  listProjects: () => gateway.listProjects(),
  listTargets: () => invoke<string[]>("list_targets"),
};
// Keep the native window chrome (title bar, traffic lights) in step with the
// theme selector: an explicit choice forces the window; "system" resets it to
// null so the window — and thus the webview's prefers-color-scheme, which the
// controller reads — tracks the OS. Without this the window was pinned dark, so
// "system" could never resolve to light.
const win = getCurrentWindow();
const themeBase = createThemeController(browserThemeDeps(() => {}));
const syncWindowChrome = () => {
  const mode = themeBase.mode();
  void win.setTheme(mode === "system" ? null : mode);
};
syncWindowChrome();
const theme = {
  ...themeBase,
  setMode: (next: Parameters<typeof themeBase.setMode>[0]) => {
    themeBase.setMode(next);
    syncWindowChrome();
  },
};

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

// A release webview has no inspector, so anything that escapes React's tree — or its render — is
// invisible unless it leaves the process: the shell writes reports to stderr, where a Terminal
// launch of Mast shows them, and the Diagnostics report carries the same ring.
const report = (message: string) => void invoke("log_error", { message }).catch(() => {});
window.addEventListener("error", (e) => {
  const detail = `${e.message}\n${e.error instanceof Error ? (e.error.stack ?? "") : ""}`;
  logError("window", detail);
  report(detail);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ""}` : String(e.reason);
  logError("promise", reason);
  report(reason);
});

// Navigation (rooms ⇄ board ⇄ terminal ⇄ spec) is React state inside <App>; it must NOT
// reload the page, or the terminal tabs and their live sessions — and all other
// in-memory state — are lost. The board writes the current spec to location.hash
// for deep-linking, and <App> syncs from it without reloading. Only the
// styleguide dev-route, which swaps the entire tree, warrants a reload.
const isStyleguide = location.hash === "#/styleguide";
window.addEventListener("hashchange", () => {
  if ((location.hash === "#/styleguide") !== isStyleguide) location.reload();
});

createRoot(container).render(
  <StrictMode>
    {isStyleguide ? (
      <Styleguide theme={theme} />
    ) : (
      <CrashScreen report={report}>
      <App
        gateway={gateway}
        theme={theme}
        terminal={(openRoomTerminal) => (
          <TerminalWorkspace
            sources={rosterSources}
            gateway={gateway}
            onOpenRoom={openRoomTerminal}
          />
        )}
        deck={tauriDeckServices}
        updater={createTauriUpdater()}
      />
      </CrashScreen>
    )}
  </StrictMode>,
);
