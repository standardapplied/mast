# Mast

Desktop cockpit for [Sail](https://github.com/standardapplied/sail). Mast connects to your
Sail control plane over SSH and gives you the spec board, agent rooms, live agent logs, a
terminal into any project container, and a file workbench.

macOS only today. The build is universal, so it runs on Apple Silicon and Intel.

## Install

Download `Mast_<version>_universal.dmg` from the
[latest release](https://github.com/standardapplied/mast/releases/latest), open it, and drag
Mast to your Applications folder.

The app is signed with a Developer ID certificate and notarized by Apple, so it opens on
first launch without a Gatekeeper warning.

Mast updates itself. It checks a few seconds after launch, and you can check on demand from
the user menu, which also shows the version you are running.

## Connecting

Paste the connect code your box's owner sent you (the one `sail fde pair` prints) into Mast's
first screen and press Connect. Mast keeps what the code carried in `~/.sail/mast.yaml` and
`~/.sail/keys/`, readable only by you, and from then on reaches the box and its project
containers with nothing else on the Mac, refusing any box whose SSH host key is not the one
the code named. "Forget this box" in the user menu deletes those files; the box keeps its side
of the pairing until its owner runs `sail fde unpair`.

### Without a connect code

When `~/.sail/mast.yaml` is absent, Mast falls back to the configuration the `sail` CLI
writes:

- `~/.sail/config.yaml` gives it the host and the control-plane address. Run
  `sail host config` to write it; with neither file Mast shows the connect code screen.
- `~/.ssh/config` gives it the route. Mast dials the host and follows every `ProxyJump` in
  the chain to reach project containers.
- Authentication tries your ssh-agent first, then key files: `IdentityFile`, the `key:` in
  `~/.sail/config.yaml`, then the default `~/.ssh/id_*`. Run `ssh-add` if your agent is
  empty.

Signing in to the control plane on this path is a passkey ceremony. Mast forwards
`127.0.0.1:7070` to the devbox, opens your browser at that origin, and captures the session
token the login page hands back.

## Development

You need [Bun](https://bun.com) 1.3.14, a stable Rust toolchain (edition 2021, 1.77+), and
macOS to run or build the app. Typecheck and tests run anywhere Bun does.

```bash
bun install
bun run dev        # tauri dev, rebuilding the web bundle first
bun test           # webview DOM + core, happy-dom preload
bun run typecheck  # tsc --noEmit
bun run build      # tauri build
```

CI runs typecheck, `bun test`, and `cargo test` on macos-15 for every pull request. Pushing
a `mast-v*` tag builds, signs, notarizes, and cuts a release.

## Layout

```
src-tauri/         Rust core
  src/ssh.rs       connection, ProxyJump chain, sftp, terminal channels, SSE streams
  src/login.rs     passkey ceremony over a temporary local forward
  src/lib.rs       the commands the webview can call
src/
  mainview/        React 19 UI: board, rooms, terminal, file workbench, updater
  mainview/tauri/  the Tauri transport, invoke plus events
  shared/          Sail API models and RPC types
docs/decisions/    ADR-per-fix records
```

The Rust core exposes about two dozen commands to the webview: `sail_request` for the
control-plane REST API, `stream_open` for SSE tails, `fs_*` for the workbench over sftp, and
`terminal_*` for interactive shells. Terminal rendering is
[ghostty-web](https://www.npmjs.com/package/ghostty-web).

## License

MIT. See [LICENSE](LICENSE).
