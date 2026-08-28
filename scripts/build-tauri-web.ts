import { cpSync, mkdirSync, rmSync } from "node:fs";

/**
 * Bundle the Tauri webview with Bun (no Vite) into `dist-tauri/`, which
 * tauri.conf.json serves as `frontendDist`: bundle the entry to `index.js`,
 * carry the static HTML + CSS alongside.
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
  // The editor (CodeMirror) is behind a dynamic import; split it into its own
  // chunk so app startup never pays for it.
  splitting: true,
  // Ship React in production mode: no dev-only checks, and StrictMode stops
  // double-invoking effects (which would otherwise re-run one-shot setup).
  define: { "process.env.NODE_ENV": '"production"' },
  naming: { entry: "index.js", chunk: "[name]-[hash].js", asset: "[name]-[hash][ext]" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

cpSync("src/mainview/static", `${OUT}/static`, { recursive: true });
cpSync("src/mainview/index.tauri.html", `${OUT}/index.html`);
// The terminal loads its pinned libghostty-vt build at runtime (see terminal/PIN.md).
cpSync("src/mainview/terminal/ghostty-vt.wasm", `${OUT}/sail-vt.wasm`);

console.log(`Built ${OUT}/ (${result.outputs.length} outputs)`);
