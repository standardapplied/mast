import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDemoGateway, createRpcGateway } from "./gateway";
import { createBridge } from "./rpc";
import { Styleguide } from "./styleguide";
import { browserThemeDeps, createThemeController } from "./theme";

const inElectrobun = location.protocol === "views:";
const bridge = inElectrobun ? createBridge() : null;
const gateway = bridge ? createRpcGateway(bridge) : createDemoGateway();

const theme = createThemeController(
  browserThemeDeps((name) => void bridge?.api.setTheme({ theme: name })),
);

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const isStyleguide = () => location.hash === "#/styleguide";
let styleguideActive = isStyleguide();
window.addEventListener("hashchange", () => {
  if (styleguideActive !== isStyleguide()) {
    styleguideActive = isStyleguide();
    location.reload();
  }
});

createRoot(container).render(
  <StrictMode>
    {styleguideActive ? <Styleguide theme={theme} /> : <App gateway={gateway} />}
  </StrictMode>,
);
