# mast-tauri-spike — findings

## Assumption 2/3/5 (transport + terminal + files): PROVEN on Linux

`spike/russh-proof` — a Rust binary using `russh` 0.45 (+ `russh-sftp`), run against a
real sshd, no `ssh` binary spawned. Output:

```
[auth]     ok — in-process russh authenticated
[terminal] ok — PTY channel live, remote tty = /dev/pts/4
[resize]   ok — pty window_change accepted (120x40)
[tunnel]   ok — direct-tcpip forward carries bytes (SSH-2.0-OpenSSH_9.6p1 …)
[files]    ok — sftp put+get round-trip (33 bytes)
```

One in-process SSH stack delivers everything Mast's two halves need:
- **PTY channel** with resize → the ghostty terminal into a container.
- **direct-tcpip forward** → the connection tunnel to the node.
- **SFTP** → the file bridge.

Because it's a library (not a subprocess), this same code runs inside the iOS/Android
sandbox — which is exactly what Electrobun/Bun (spawn `ssh`) cannot do. This is the
technical basis for mobile Mast.

Run it:  `cargo run -- <private_key_path> <user>`  (needs a reachable sshd).

## Assumption 1 (the app itself compiles as Tauri): PROVEN on Linux

The `src-tauri/` app now builds end to end — the **existing React frontend** (bundled by
Bun into `dist-tauri/`, no Vite) wired to a **Rust core** that wraps the proven russh stack
behind Tauri `invoke` commands:

- `sail_request` — HTTP to the control plane over a direct-tcpip forward (token injected in
  Rust, never in the webview) → the whole board/spec/dispatch surface.
- `terminal_open` / `_write` / `_resize` / `_close` — a PTY channel streamed to the webview
  as Tauri events → the terminal half (`#/terminal` route, `TerminalPane.tsx`).
- `connection_status` — config + session state for the connection banner.

`cargo build` links `tauri` + `russh` + `tokio` + WebKitGTK in one binary, zero warnings.
`bun test` (181) and `tsc` stay green. The React Gateway is unchanged — only the transport
seam swapped (`createTauriGateway` instead of the Electrobun bridge).

## Still to prove — on the Mac (need Xcode / a device)

1. **Render** — the bundle in iOS WKWebView (desktop WebKitGTK already compiles; visual
   check pending). `bun run tauri dev` on the Mac is the fastest look.
2. **Auth** — passkey / WebAuthn in the mobile system webview (the `login()` loopback
   ceremony is stubbed pending this).
3. **On-device** — `bun run tauri ios init && bun run tauri ios dev`, then a container
   terminal + control-plane board from a phone over cellular.

## Verdict

Both make-or-break unknowns are now GREEN: (a) Rust does the full SSH stack in-process
(mobile-capable), and (b) the real Mast app compiles as a Tauri binary with the React
frontend intact. Everything left is on-device UI validation the Mac owns.

## `~/.ssh/config` + ProxyJump: RESOLVED in-process

The Rust core now reads `~/.ssh/config`: it resolves the `host` alias
(`HostName`/`User`/`Port`/`IdentityFile`/`ProxyJump`, first-value-wins with `*`/`?` globs)
and dials the full jump chain in-process — connect hop 1, forward a channel to hop 2, run
SSH over it, repeat, until the devbox session rides the last hop (every jump handle kept
alive so its channel stays open). Connect + request are timeout-bounded (20s) so a bad host
surfaces an error instead of a hung loader. 8 Rust unit tests cover the config parsing,
hop expansion, chunk decoding, and HTTP parsing.

## Known scaffold gaps (deliberate, for the productization pass)

- SSH auth tries `IdentityFile` from ssh_config, then `key:` from `~/.sail`, then the
  default `~/.ssh/id_*`; ssh-agent (and encrypted-key passphrase prompts) is a follow-up.
- Host key is trusted-on-first-use (no known_hosts pinning yet).
- `TerminalPane` is a raw byte harness, not a VT emulator — ghostty-web / xterm needs a
  dependency-approval decision.
- Live SSE events (`onEvent`) and the passkey `login()` ceremony are stubbed.
