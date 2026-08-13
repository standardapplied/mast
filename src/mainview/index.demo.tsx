import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDemoGateway } from "./gateway";
import { browserThemeDeps, createThemeController } from "./theme";

/**
 * Browser preview entry: the real App backed by the seeded demo gateway, with
 * no Tauri IPC, terminal, or updater. Built and served by `scripts/preview.ts`
 * so the UI can be eyeballed in a plain browser (or over an SSH port-forward)
 * without a macOS build or a live control plane.
 */
document.documentElement.classList.add("in-shell");

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const theme = createThemeController(browserThemeDeps(() => {}));

createRoot(container).render(
  <StrictMode>
    <App gateway={createDemoGateway()} theme={theme} />
  </StrictMode>,
);
