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

## State architecture

Law, not preference — review against these:

- **One owner per shared domain.** State read by more than one surface lives in exactly one
  store (the presenceStore mold: class singleton, `useSyncExternalStore`, a `connectX`
  seeding function wired in App). Components hold render-local state only; a second private
  cache of a shared domain is a bug even when it works.
- **Mutations route through the owner, loud.** The store applies the optimistic transition,
  issues the gateway call, and reconciles on the ack. A refusal or error renders where the
  intent originated — inline on the card/row/chip — and is never swallowed. No
  fire-and-forget gateway calls from components.
- **Events accelerate, they never carry.** Live events may fold in optimistically and kick a
  refetch, but correctness must hold with the event lane fully dead: every mutation ack,
  surface enter/leave, window focus, and stream reconnect is a deterministic reconcile
  point.
- **Persistence stores arrangement, never existence.** localStorage may remember how things
  were laid out, never whether they exist — existence is the backend's truth, checked
  against the owner's records (a session the store watched dying is never resurrected by a
  stored layout).
- **Scope refetches to what the event names.** An event refreshes the state it identifies,
  not the world; anything outside the vocabulary falls back to the conservative refresh so
  a new server event type is never silently dropped.

## Releasing

Bump `version` in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and
the `mast` entry in `src-tauri/Cargo.lock` together, then push a `mast-v<version>` tag. CI
builds, signs, notarizes, repoints the updater manifest at the release downloads, and
publishes the release.

GitHub Releases is the only distribution channel: first-time installs download the `.dmg`
from it, and the updater polls `releases/latest/download/latest.json` on the same releases.
That works because the repo is public, so a release must actually be published for either
to resolve. Publishing is the last step of the job for that reason.
