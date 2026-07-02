import type { ElectrobunConfig } from "electrobun/bun";

/**
 * Bundle/copy/release config. `electrobun build` bundles the React webview
 * itself via Bun.build (`build.views`, target browser) into the bundle's
 * `views/mainview/` (served via the `views://` scheme); `build.copy` carries
 * the static HTML/CSS alongside. `bundleCEF` is false — we render with the OS
 * WebView, no Chromium. Signing/notarization are enabled by CI on tagged
 * releases (via env), never committed on by default.
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
    views: {
      mainview: { entrypoint: "src/mainview/index.tsx" },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/static": "views/mainview/static",
    },
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      icons: "icons/AppIcon.iconset",
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
    exitOnLastWindowClosed: true,
  },
  release: {
    baseUrl: process.env.MAST_RELEASE_BASE_URL ?? "https://sail-artifacts.standardapplied.sh/mast",
  },
};

export default config;
