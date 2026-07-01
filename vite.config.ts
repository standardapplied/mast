import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the React webview from `src/mainview` into `dist/`. `base: "./"` keeps
 * asset URLs relative so they resolve under the `views://mainview/` scheme in the
 * packaged app. `electrobun build` then copies `dist/` into the bundle.
 */
export default defineConfig({
  root: "src/mainview",
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
});
