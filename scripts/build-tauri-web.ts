import { cpSync, mkdirSync, rmSync } from "node:fs";

/**
 * Bundle the Tauri webview with Bun (no Vite) into `dist-tauri/`, which
 * tauri.conf.json serves as `frontendDist`. Mirrors what `electrobun build`
 * does for the Bun/WebView build, minus the native shell: bundle the entry to
 * `index.js`, carry the static HTML + CSS alongside.
 */

const OUT = "dist-tauri";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/mainview/index.tauri.tsx"],
  outdir: OUT,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  naming: { entry: "index.js", chunk: "[name]-[hash].js", asset: "[name]-[hash][ext]" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

cpSync("src/mainview/static", `${OUT}/static`, { recursive: true });
cpSync("src/mainview/index.tauri.html", `${OUT}/index.html`);
// ghostty loads its ~400KB VT parser at runtime from `/ghostty-vt.wasm`.
cpSync("node_modules/ghostty-web/ghostty-vt.wasm", `${OUT}/ghostty-vt.wasm`);

console.log(`Built ${OUT}/ (${result.outputs.length} outputs)`);
