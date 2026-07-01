# Mast

Isolated development environments for AI agents — a macOS-first desktop app built
on **Electrobun + Bun** (OS WebView, no Chromium; Bun main process).

This repo is the app shell: the window, the typed main↔webview RPC, the bridge
watchdog, macOS shell-env resolution, auto-update, and the build/sign/CI
pipeline. Feature work (terminal, file bridge, control-plane UI, design system)
lands in its own specs on top of this foundation.

## Requirements

- [Bun](https://bun.com) 1.3+
- macOS to run/build the actual app (`electrobun dev` / `electrobun build`);
  everything else (typecheck, tests) runs on any platform Bun supports.

## Commands

```bash
bun install
bun run dev        # vite dev server (:5173) + electrobun dev --watch
bun test           # webview DOM + Bun main + CLI, one run (happy-dom preload)
bun run typecheck  # tsc --noEmit
bun run build      # vite build → electrobun build
```

## Layout

```
electrobun.config.ts   bundle/copy/release config (bundleCEF: false)
vite.config.ts         builds the React webview (src/mainview → dist/)
tailwind.config.js     dark-first CSS-var tokens (filled by the design system)
src/
  bun/         main process: window-manager, rpc, shell-env, updater
  mainview/    webview: React 19 entry, rpc bridge, watchdog, push events
  shared/      types.ts — the single AppRPCSchema
docs/decisions/  ADR-per-fix records
```

## How it fits together

- **RPC** — one `AppRPCSchema` (`src/shared/types.ts`) drives both ends. Bun uses
  `BrowserView.defineRPC`; the webview uses `Electroview.defineRPC`. Push messages
  are re-dispatched in the DOM as `rpc:*` CustomEvents.
- **Bridge watchdog** — recovers the localhost socket after sleep (see
  [ADR 0002](docs/decisions/0002-bridge-watchdog.md)).
- **Shell env** — a Finder-launched `.app` has a bare PATH; `resolveShellEnv`
  loads the real login-shell env before anything shells out.
- **Auto-update** — Electrobun `Updater`, 30-min checks with exponential backoff;
  signing/notarization run only in CI on tagged releases.
