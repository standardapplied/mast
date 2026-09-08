import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HostListing } from "../terminal/connection";
import { TerminalRenderer } from "../terminal/renderer";
import type { SessionLink, TerminalServices } from "../terminal/terminalServices";

/**
 * The Tauri side of the pane's seam: `session_*` commands over `invoke`, the data lane as a raw
 * `Channel`, meta/exit as `session://` events, the bundled wasm, and the WebGPU/WebGL2 renderer.
 */

/** The pinned VT wasm, fetched and compiled once; every pane instantiates its own copy. */
let wasmPromise: Promise<WebAssembly.Module> | null = null;
function vtWasm(): Promise<WebAssembly.Module> {
  wasmPromise ??= fetch("/sail-vt.wasm").then(async (r) => {
    if (!r.ok) throw new Error(`VT wasm failed to load (${r.status})`);
    return WebAssembly.compile(await r.arrayBuffer());
  });
  return wasmPromise;
}

/** What the terminal answers to XTVERSION (CSI > q); resolved once. */
let identityPromise: Promise<string> | null = null;
function mastIdentity(): Promise<string> {
  identityPromise ??= getVersion().then(
    (version) => `mast ${version}`,
    () => "mast",
  );
  return identityPromise;
}

/**
 * The system clipboard as text: the Rust side (`pbpaste`) first — WKWebView's own clipboard read
 * is gesture-gated and its paste event never fires on a non-editable surface — then the browser
 * API as the non-Tauri fallback. Empty string when both decline.
 */
async function readClipboard(): Promise<string> {
  try {
    return await invoke<string>("clipboard_read_text");
  } catch {
    try {
      return (await navigator.clipboard?.readText()) ?? "";
    } catch {
      return "";
    }
  }
}

const link: SessionLink = {
  list: (socketPath, token) => invoke<HostListing>("session_list", { socketPath, token }),
  async open(spec, lanes) {
    // One ordered raw channel carries bytes AND replay markers: only one channel can guarantee
    // that a mid-stream replay resets the terminal before its snapshot bytes land.
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (message) => lanes.onData(message);
    const unlisten = await Promise.all([
      listen<unknown>(`session://meta/${spec.id}`, (e) => lanes.onMeta(e.payload)),
      listen<unknown>(`session://exit/${spec.id}`, (e) => lanes.onExit(e.payload)),
    ]);
    const detach = () => unlisten.forEach((off) => off());
    try {
      await invoke("session_open", { ...spec, onData });
    } catch (e) {
      detach();
      throw e;
    }
    return detach;
  },
  // Raw body, id in a header: no JSON number array per keystroke byte.
  write: (id, bytes) => invoke("session_write", bytes, { headers: { "x-mast-session": id } }),
  resize: (id, cols, rows) => invoke("session_resize", { id, cols, rows }),
  takeWrite: (id) => invoke("session_take_write", { id }),
  close: (id) => invoke("session_close", { id }),
  readClipboard,
};

export const tauriTerminalServices: TerminalServices = {
  link,
  wasm: vtWasm,
  createRenderer: (canvas, opts) => TerminalRenderer.create(canvas, opts),
  identity: mastIdentity,
};
