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
- Modules imported by tests must not import `@tauri-apps/*` at load: it needs the IPC host,
  which does not exist under `bun test`. Keep pure logic in transport-free modules and
  inject the side effects. The transport lives behind `src/mainview/tauri/`, and
  `index.tauri.tsx` is the only place that wires it up.
- No sleeps/waits in tests. Drive async paths with callbacks and injected timers.
- `tauri dev`/`tauri build` run only on macOS. CI (`macos-15`) is the verification path for
  the app bundle. Everything else must pass locally with `bun test` and `bun run typecheck`.

## Releasing

Bump `version` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and
the `mast` entry in `src-tauri/Cargo.lock` together, then push a `mast-v<version>` tag. CI
builds, signs, notarizes, repoints the updater manifest at the release downloads, and
publishes the release.

GitHub Releases is the only distribution channel: first-time installs download the `.dmg`
from it, and the updater polls `releases/latest/download/latest.json` on the same releases.
That works because the repo is public, so a release must actually be published for either
to resolve. Publishing is the last step of the job for that reason.
