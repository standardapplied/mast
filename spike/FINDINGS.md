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

## Still to prove — on the Mac (need Xcode / a device)

1. Render — the existing React build in Tauri's webview (desktop WebKitGTK + iOS WKWebView).
2. Auth — passkey / WebAuthn in the mobile system webview.
3. On-device — tunnel over cellular + a container terminal from a phone.

## Verdict so far

The riskiest, most decision-relevant unknown (can Rust do the whole SSH stack in-process,
incl. mobile) is settled GREEN. Nothing here argues against the Tauri pivot; the remaining
checks are UI/mobile validation that only the Mac can do.
