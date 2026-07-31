import { invoke } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Styleguide } from "./styleguide";
import { createTauriGateway } from "./tauri/gateway";
import type { RosterSources } from "./tauri/projectRoster";
import { TerminalWorkspace } from "./tauri/TerminalWorkspace";
import { createTauriUpdater } from "./tauri/updater";
import { browserThemeDeps, createThemeController } from "./theme";

/**
 * The webview entry: the React app backed by the Rust `invoke` gateway, which
 * runs the SSH stack in-process. Transport lives behind `./tauri/`, so this
 * bundle stays portable to iOS/Android.
 */

document.documentElement.classList.add("in-shell");

const gateway = createTauriGateway();
const rosterSources: RosterSources = {
  listProjects: () => gateway.listProjects(),
  listTargets: () => invoke<string[]>("list_targets"),
};
const theme = createThemeController(browserThemeDeps(() => {}));

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

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
      <App
        gateway={gateway}
        theme={theme}
        terminal={<TerminalWorkspace sources={rosterSources} />}
        updater={createTauriUpdater()}
      />
    )}
  </StrictMode>,
);
