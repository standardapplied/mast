# Mast

macOS desktop cockpit for Sail, built on **Tauri v2**: a Rust core (`src-tauri/`) that owns
the SSH transport, and a React 19 webview (`src/mainview/`) that talks to it over Tauri
commands and events. See README.md for layout and docs/decisions/ for the ADRs that
constrain design choices.

## Toolchain

Two toolchains, one per side of the bridge.

Frontend is Bun only: package manager, runtime, bundler (`bun run build:tauri-web` →
`Bun.build` → `dist-tauri/`), and test runner (`bun test`, happy-dom preload, no vitest). No
Vite, no PostCSS, no Node-ecosystem build tools. Styling is plain CSS-variable tokens in
`src/mainview/static/tokens.css` with `components.css` on top, no Tailwind.

Core is stable Rust (edition 2021, 1.77+), verified with `cargo test`. Do not add
dependencies on either side without explicit approval.

## Rules

- Never attribute commits, PRs, or any git artifact to Claude/AI: no
  `Co-Authored-By: Claude ...` trailers, no `🤖 Generated with Claude Code` footers, no
  assistant mentions. Messages read as if the author wrote them.
- Modules imported by tests must not import a native bridge at load: `@tauri-apps/*` needs
  the IPC host, and `electrobun/bun` dlopens native libs. Keep pure logic in bridge-free
  modules and inject the side effects. The transport lives behind
  `src/mainview/tauri/`, and `index.tauri.tsx` is the only place that wires it up.
- No sleeps/waits in tests. Drive async paths with callbacks and injected timers.
- `tauri dev`/`tauri build` run only on macOS. CI (`macos-15`) is the verification path for
  the app bundle. Everything else must pass locally with `bun test` and `bun run typecheck`.
- `src/bun/` and `electrobun.config.ts` are the earlier Electrobun shell, still carrying
  unit tests that `bun test` runs. Nothing there ships. Do not build new features on it.

## Releasing

Bump `version` in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`
together, then push a `mast-v<version>` tag. CI builds, signs, notarizes, mirrors the
artifacts to the GCS bucket the updater polls, and publishes the GitHub release.

Two distribution channels, not interchangeable. GitHub Releases is the human front door for
first-time installs. The GCS bucket is the updater channel, and every install from 0.1.3
onward has that URL compiled into the bundle, so the bucket has to keep serving.
