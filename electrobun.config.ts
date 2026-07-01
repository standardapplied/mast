import type { ElectrobunConfig } from "electrobun/bun";

/**
 * Bundle/copy/release config. The React webview is built by vite into `dist/`
 * and copied whole into the bundle's `views/mainview/` (served via the
 * `views://` scheme). `bundleCEF` is false — we render with the OS WebView, no
 * Chromium. Signing/notarization are enabled by CI on tagged releases (via env),
 * never committed on by default.
 */
const config: ElectrobunConfig = {
  app: {
    name: "Mast",
    identifier: "sh.standardapplied.mast",
    version: "0.1.0",
    description: "Isolated development environments for AI agents.",
  },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    copy: { dist: "views/mainview" },
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      codesign: process.env.MAST_CODESIGN === "1",
      notarize: process.env.MAST_NOTARIZE === "1",
      entitlements: {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.files.user-selected.read-write": true,
        "com.apple.security.files.downloads.read-write": true,
        "com.apple.security.files.desktop.read-write": true,
      },
    },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  release: {
    baseUrl: process.env.MAST_RELEASE_BASE_URL ?? "https://sail-artifacts.standardapplied.sh/mast",
  },
};

export default config;
