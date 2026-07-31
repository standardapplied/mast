# 0003 — Retire the Electrobun shell

Date: 2026-07-31
Status: Accepted
Supersedes: [0001](0001-electrobun-bun-foundation.md), [0002](0002-bridge-watchdog.md)

## Context

0001 chose Electrobun + Bun: OS WebView, Bun main process, native window and RPC
through Electrobun's Zig/ObjC bindings. The app has since shipped on Tauri v2
with a Rust core that owns an in-process SSH session (russh), because a spawned
`ssh` binary is not available on iOS/Android. Every release from 0.1.3 on is the
Tauri build.

The Electrobun tree stayed behind. It was unreachable from the shipped entry
point, at runtime and through type-only edges, and nothing in `dist-tauri/`
referenced it. What it still did was cost: 84 tests ran against a shell that no
longer exists, a `three` type shim existed only because `electrobun/bun`
re-exports it, and CLAUDE.md briefed every agent on the wrong foundation.

## Decision

Delete it. `src/bun/`, `src/mainview/rpc.ts`, `src/mainview/index.tsx`, the two
Electrobun HTML entries, `electrobun.config.ts`, the `electrobun` dependency, and
`types/shims.d.ts`.

Three things fell out with it, all reachable only from the retired shell:

- `createRpcGateway`, the Electrobun-backed `Gateway`. `createDemoGateway` stays:
  the browser preview and most UI tests run on it.
- `watchdog.ts`, the subject of 0002. It recovered the localhost WebSocket
  between webview and Bun main. Tauri has no such socket, so the failure mode it
  guarded against cannot occur.
- The `bridge-status` push, its `BridgeStatus` type, and the "Recovering…" pill.
  Only the Bun main ever emitted that message, so after the pivot the pill could
  not render. Connection health is the `connection-status` push, which the Rust
  core drives and the toolbar already shows.

`quit-gate.ts` went too. It was the webview half of a `confirmQuit` request the
Bun main sent on programmatic quit. Nothing ever registered a gate, so it
defaulted to allowing the quit; no behaviour is lost. **A Tauri app that wants an
unsaved-work prompt has to build it on `onCloseRequested`, which does not exist
today.**

0001 and 0002 stay in the tree. They record why those choices were right at the
time, and ADRs here are append-only.

## Consequences

- One toolchain per side of the bridge: Bun for the webview, Cargo for the core.
  A contributor no longer has to work out which of two shells they are reading.
- The suite drops from 519 tests to 420. The removed tests covered the retired
  shell, so shipped coverage is unchanged.
- `src/shared/types.ts` is transport-neutral now: no `AppRPCSchema`, no bridge
  constants. It carries the result envelope, the push payloads, and nothing that
  names a transport.
- The webview bundle is unchanged, byte for byte in behaviour: the dead tree was
  never in it.
