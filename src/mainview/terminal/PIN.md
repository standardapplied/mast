# Vendored libghostty-vt WebAssembly

`ghostty-vt.wasm` is the official terminal VT core from the Ghostty project — the
parser + terminal state (PageList grid + scrollback), with NO renderer. We feed it raw
PTY bytes and read the resulting cell grid to render ourselves (WebGPU).

- **Build**: libghostty-vt 1.3.2 (`+d9840f3`), from the Ghostty `tip` release.
- **Source**: https://github.com/ghostty-org/ghostty/releases/tag/tip
- **License**: MIT (Ghostty).
- **Obtained**: 2026-08-27.
- **SHA-256**: `14d0f5ca8780bb974aeffbf6ef7947fe16b9ae0f8b32782e69ebecb85e4d1b1f`
- **ABI**: raw `ghostty_*` C symbols, zero host imports, self-contained. Bound via
  `vtCore.ts`. The C ABI is a public alpha (no tagged release yet) — `vtCore.ts` wraps it
  behind our own stable interface so upstream churn is isolated to one file. Re-pin by
  replacing this file and updating the SHA.

## Vendored headers (`ghostty-vt-headers/`)

`key_event.h` and `key_encoder.h` (fetched 2026-08-28 from ghostty `main`, matching the
pinned tip build) are vendored because the `GhosttyKey` enum has IMPLICIT ordinals — the
declaration order is the ABI — and `input.ts` mirrors it as `GHOSTTY_KEY`.
`ghosttyHeaders.test.ts` parses the vendored headers and verifies the mirror entry-for-entry
plus the encoder option/action/mod constants, and the wasm-driven tests in `vtCore.test.ts`
verify real encodings, so drift fails loudly at both seams. **Re-pin the headers together
with the wasm**, then run `bun test` and fix whatever those two suites report.
