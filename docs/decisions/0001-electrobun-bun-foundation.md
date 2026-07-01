# 0001 — Electrobun + Bun foundation

Date: 2026-07-01
Status: Accepted

## Context

Mast is a macOS-first desktop app that shells out heavily (ssh, rsync, agents)
and must stay small and fast. Electron bundles Chromium (~150 MB) and runs a
Node main process; we want the OS WebView and a Bun main.

## Decision

- **Electrobun + Bun.** OS WebView (`bundleCEF: false`), Bun main process. Native
  window/RPC via Electrobun's Zig/ObjC bindings.
- **One toolchain.** Bun is the package manager, runtime, and test runner.
  `bun test` with a happy-dom preload (`bunfig.toml [test] preload`) covers the
  webview DOM, the Bun main, and any CLI in a single run — no vitest. Vite stays
  only as the React webview bundler that `electrobun build` consumes.
- **One RPC schema.** `src/shared/types.ts` `AppRPCSchema` is the single, typed,
  transport-agnostic contract for both sides; a future WS/remote transport drops
  in without touching app code.
- **Testability via dependency injection.** FFI-bound side effects (quit, build
  metadata, sockets, timers) are injected, so the request handlers, window
  registry, navigation policy, backoff, shell-env parser, push re-dispatch, and
  bridge watchdog are all unit-tested on Linux CI/dev without native bindings.

## Consequences

- `electrobun build` / `bun run dev` require macOS; they are exercised in CI on a
  `macos-15` (arm64) runner. Everything else runs anywhere Bun runs.
- Modules imported by tests must not import `electrobun/bun` (it dlopens native
  libs at module load). Pure logic lives in electrobun-free modules.
