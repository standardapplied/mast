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
