# 0001 — Tauri v2 with a Rust core

Date: 2026-08-01
Status: Accepted

## Context

Mast is a desktop cockpit for Sail. Everything it shows comes from a devbox
reached over SSH: the control-plane API, container terminals, and files.

The obvious way to reach it is to spawn the `ssh` binary. That closes the door on
iOS and Android, where an app cannot spawn arbitrary executables. Mast is
intended to run there, so the SSH client has to be in-process.

## Decision

Tauri v2. A Rust core (`src-tauri/`) owns an in-process SSH session built on
`russh` and `russh-sftp`: it dials the host, follows the `ProxyJump` chain from
`~/.ssh/config`, proxies the control-plane API over a `direct-tcpip` forward,
opens PTY channels for terminals, and moves files over sftp. A React 19 webview
(`src/mainview/`) reaches it through Tauri commands and events.

The transport is confined to `src/mainview/tauri/`, and `index.tauri.tsx` is the
only module that wires it up. Everything above that seam is transport-agnostic
and compiles unchanged against a future WS or remote seam.

Two toolchains, one per side of the bridge: Bun for the webview (package manager,
bundler, test runner), Cargo for the core.

## Consequences

- The app runs where a spawned `ssh` cannot, which is the whole point.
- The webview never sees the bearer token or the tunnel. The Rust core injects
  credentials, so a compromised webview cannot exfiltrate them.
- `tauri dev` and `tauri build` require macOS. CI on `macos-15` is the
  verification path for the bundle; typecheck and both test suites run anywhere.
- **There is no unsaved-work prompt on quit.** Adding one means handling Tauri's
  `onCloseRequested`, which the app does not do today.
