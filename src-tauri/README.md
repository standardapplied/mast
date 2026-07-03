# Mast — Tauri backend (spike)

The Rust core of the Tauri build. The webview is the same React app as the
Electrobun build; this crate replaces the Bun main process with a Rust one that
owns an in-process SSH session (russh) to the devbox — the piece that lets Mast
run on iOS/Android, where a spawned `ssh` binary cannot.

## Layout

- `src/lib.rs` — Tauri builder + `invoke` command surface (desktop & mobile).
- `src/ssh.rs` — the russh session: HTTP proxy, PTY terminals, config loading.
- `src/main.rs` — desktop launcher.
- `tauri.conf.json` — `frontendDist: ../dist-tauri` (built by `bun run build:tauri-web`).

## Run on the Mac

```bash
bun install
bun run tauri dev            # desktop — validates render + board over SSH

bun run tauri ios init       # once: generates the Xcode project
bun run tauri ios dev        # on a device/simulator — the mobile checks
```

`tauri dev` runs `build:tauri-web` first (via `beforeDevCommand`), so the React
bundle is always fresh. Needs `~/.sail/config.yaml` (host/user/server/token) for
a live connection; without it the app still renders and reports the error.

## The command surface (mirrors the React `Gateway`)

| invoke | purpose |
| --- | --- |
| `sail_request {method, path, body?, ifMatch?}` | HTTP to the control plane over the tunnel |
| `connection_status` | config + session state for the banner |
| `terminal_open {id, cols, rows}` | open a PTY; bytes arrive on `terminal://data/{id}` |
| `terminal_write {id, data}` / `terminal_resize` / `terminal_close` | drive the PTY |

See `../spike/FINDINGS.md` for what's proven vs. the deliberate scaffold gaps.
