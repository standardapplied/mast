# 0002 — Bridge watchdog for the webview↔Bun socket

Date: 2026-07-01
Status: Accepted

## Context

Electrobun's webview↔Bun bridge is a localhost WebSocket with **no
auto-reconnect**. After the laptop sleeps, macOS tears the socket down; Electrobun
does not re-establish it, and the app silently wedges — RPC calls hang forever.

## Decision

`BridgeWatchdog` (`src/mainview/watchdog.ts`) owns recovery for exactly one
bridge (the RPC transport is one-per-`BrowserView`, never shared):

- **Health check:** ping every 30s and on window `focus` / `visibilitychange`.
- **Single recovery path:** a failed ping closes the socket; the socket's `close`
  event drives `initSocketToBun()` — the same path taken when the OS closes the
  socket on sleep. Recovery logic lives in one place.
- **Last resort:** after N consecutive failed pings, `location.reload()` (the Bun
  main stays alive, so a reload is cheap and always recovers).

All collaborators (ping, reload, timers, window/document) are injected, so the
recovery paths are driven synchronously in tests — the forced-close path is
exercised by invoking the socket's `close` callback, with no timing waits.

## Consequences

- The watchdog is the only thing keeping the app usable across sleep cycles;
  changes here need the `watchdog.test.ts` cases to stay green.
- Ping uses the normal typed RPC (`api.ping`), so a dead bridge surfaces as a
  timeout/rejection — exactly what the watchdog treats as failure.
