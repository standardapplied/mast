# Vendored libghostty-vt WebAssembly

`ghostty-vt.wasm` is the official terminal VT core from the Ghostty project — the
parser + terminal state (PageList grid + scrollback), with NO renderer. We feed it raw
PTY bytes and read the resulting cell grid to render ourselves (WebGPU).

- **Build**: libghostty-vt 1.3.2 (`+44f2a44`, 2026-09-10), from the Ghostty `tip` release.
- **Source**: https://github.com/ghostty-org/ghostty/releases/tag/tip
- **License**: MIT (Ghostty).
- **Obtained**: 2026-09-10.
- **SHA-256**: `0fb5949ce28da01bf265143782b2b44487568fefd6ff40528900688565ec6a12`
- **Signature**: `ghostty-vt.wasm.minisig` from the same release verified with Ghostty's
  minisign key (published in its `PACKAGING.md`):
  `minisign -Vm ghostty-vt.wasm -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV`
- **Previous pin**: `+d9840f3` (2026-08-26). This pin adds the `ghostty_search_*` exports
  (terminal search, upstream PR #14097), the fix that marks the previous row dirty when a
  wrapped wide char's spacer head is cleared (`eb722cb`), and the RefCountedSet over-count
  fix; no export was removed and every header `vtCore.ts`/`input.ts` derive from is
  unchanged. Kitty graphics stays disabled on wasm32-freestanding by upstream build policy.
- **ABI**: raw `ghostty_*` C symbols, zero host imports, self-contained. Bound via
  `vtCore.ts`. The C ABI is a public alpha (no tagged release yet) — `vtCore.ts` wraps it
  behind our own stable interface so upstream churn is isolated to one file. Re-pin by
  replacing this file and updating the SHA.

## Vendored headers (`ghostty-vt-headers/`)

`key_event.h` and `key_encoder.h` (`include/ghostty/vt/key/{event,encoder}.h` from the
pinned build's `libghostty-vt-source.tar.gz`, re-fetched 2026-09-10) are vendored because the
`GhosttyKey` enum has IMPLICIT ordinals — the declaration order is the ABI — and `input.ts`
mirrors it as `GHOSTTY_KEY`.
`ghosttyHeaders.test.ts` parses the vendored headers and verifies the mirror entry-for-entry
plus the encoder option/action/mod constants, and the wasm-driven tests in `vtCore.test.ts`
verify real encodings, so drift fails loudly at both seams. **Re-pin the headers together
with the wasm**, then run `bun test` and fix whatever those two suites report.
