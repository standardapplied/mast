import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBridge } from "./rpc";
import { Styleguide } from "./styleguide";
import { browserThemeDeps, createThemeController } from "./theme";

const inElectrobun = location.protocol === "views:";
const bridge = inElectrobun ? createBridge() : null;

const theme = createThemeController(
  browserThemeDeps((name) => void bridge?.api.setTheme({ theme: name })),
);

window.addEventListener("hashchange", () => location.reload());

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>{location.hash === "#/styleguide" ? <Styleguide theme={theme} /> : <App />}</StrictMode>,
);
