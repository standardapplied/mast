import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Styleguide } from "./styleguide";
import { createTauriGateway } from "./tauri/gateway";
import { TerminalPane } from "./tauri/TerminalPane";
import { browserThemeDeps, createThemeController } from "./theme";

/**
 * Tauri webview entry. Same React app as the Electrobun build, but backed by
 * the Rust `invoke` gateway (SSH stack in-process) instead of the Bun bridge.
 * No `electrobun/*` import — this bundle is transport-clean for iOS/Android.
 */

document.documentElement.classList.add("in-shell");

const gateway = createTauriGateway();
const theme = createThemeController(browserThemeDeps(() => {}));

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const route = () => location.hash;
let current = route();
window.addEventListener("hashchange", () => {
  if (current !== route()) {
    current = route();
    location.reload();
  }
});

function view() {
  if (current === "#/terminal") return <TerminalPane />;
  if (current === "#/styleguide") return <Styleguide theme={theme} />;
  return <App gateway={gateway} theme={theme} />;
}

createRoot(container).render(<StrictMode>{view()}</StrictMode>);
