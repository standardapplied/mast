# Mast

macOS-first desktop app on **Electrobun + Bun**. See README.md for layout and
docs/decisions/ for the ADRs that constrain design choices.

## Toolchain

Bun only: package manager, runtime, bundler (`electrobun build` → `Bun.build`),
and test runner (`bun test`, happy-dom preload — no vitest). No Vite, no
PostCSS, no Node-ecosystem build tools. Styling is plain CSS-variable tokens in
`src/mainview/styles.css` — no Tailwind. Do not add dependencies without
explicit approval.

## Rules

- Never attribute commits, PRs, or any git artifact to Claude/AI: no
  `Co-Authored-By: Claude ...` trailers, no `🤖 Generated with Claude Code`
  footers, no assistant mentions. Messages read as if the author wrote them.
- Modules imported by tests must not import `electrobun/bun` (it dlopens native
  libs at load). Keep pure logic in electrobun-free modules; inject FFI-bound
  side effects.
- No sleeps/waits in tests — drive async paths with callbacks and injected
  timers.
- `electrobun dev`/`build` run only on macOS; CI (`macos-15`) is the
  verification path for the app bundle. Everything else must pass locally with
  `bun test` and `bun run typecheck`.
