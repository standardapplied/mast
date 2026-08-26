# Renderer spike

A runnable page that drives the real `TerminalRenderer` (WebGPU, WebGL2 fallback) from live
`VtCore` (libghostty-vt) state, so the output can be eyeballed against native Ghostty. Not shipped —
`renderer.ts` is the foundation for the real terminal widget; `spike.ts` + `spike.html` are the
throwaway harness around it.

`spike/` is excluded from `tsc` (see the repo `tsconfig.json`): the WebGPU types aren't in the
project and `@webgpu/types` is a dependency we haven't taken yet. `bun build` erases types, so the
bundle builds regardless. Promoting `renderer.ts` to the app means adding `@webgpu/types` and
dropping the exclude.

## Rebuild the self-contained page

```sh
bun build src/mainview/terminal/spike/spike.ts \
  --outfile /tmp/spike-bundle.js --target browser --format iife --minify
# then inline the wasm (base64) and the bundle into spike.html's __WASM_B64__ / __BUNDLE__ markers
python3 - <<'PY'
import base64, pathlib
wasm = base64.b64encode(pathlib.Path("src/mainview/terminal/ghostty-vt.wasm").read_bytes()).decode()
bundle = pathlib.Path("/tmp/spike-bundle.js").read_text()
html = pathlib.Path("src/mainview/terminal/spike/spike.html").read_text()
pathlib.Path("/tmp/renderer-spike.html").write_text(
    html.replace("__WASM_B64__", wasm).replace("__BUNDLE__", bundle))
PY
# open /tmp/renderer-spike.html in a WebGPU browser (Chrome on macOS) to eyeball.
```
