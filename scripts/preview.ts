import { cpSync, mkdirSync, rmSync } from "node:fs";

/**
 * Build the demo webview (browser entry, seeded demo gateway, no Tauri) into
 * `dist-demo/` and serve it, so the UI can be eyeballed in a browser or over an
 * SSH port-forward without a macOS build. Not a release artifact.
 */
const OUT = "dist-demo";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const built = await Bun.build({
  entrypoints: ["src/mainview/index.demo.tsx"],
  outdir: OUT,
  target: "browser",
  splitting: true,
  define: { "process.env.NODE_ENV": '"production"' },
  naming: { entry: "index.js", chunk: "[name]-[hash].js", asset: "[name]-[hash][ext]" },
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
cpSync("src/mainview/static", `${OUT}/static`, { recursive: true });
cpSync("src/mainview/index.tauri.html", `${OUT}/index.html`);

const port = Number(process.env.PREVIEW_PORT ?? 4321);
const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    let path = new URL(req.url).pathname;
    if (path === "/") path = "/index.html";
    return new Response(Bun.file(OUT + path));
  },
});
console.log(`Mast preview on http://localhost:${server.port}`);
