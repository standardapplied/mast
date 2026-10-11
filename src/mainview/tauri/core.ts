import { invoke as send, type InvokeArgs } from "@tauri-apps/api/core";

/**
 * This page's line to the Rust core. A page is for one backend, the first one a status names:
 * every command carries that name, and the core serves it from that backend or refuses it. So
 * nothing a page began on one box (a kill waiting on a lookup, a save, a close) can land on the
 * box that replaced it. Pairing, forgetting, or a status that names another backend ends the
 * page ({@link restartPage}); the next page binds to the backend that is there then.
 */
const BACKEND_HEADER = "x-mast-backend";

let backend: number | null = null;

/**
 * Binds the page to the backend its first status names. False when a status names another one
 * (or none, once bound): the page's box is gone and only a new page can be for the one there now.
 */
export function bindPage(named: number | null | undefined): boolean {
  if (backend === null) backend = named ?? null;
  return backend === (named ?? null);
}

/** Test seam: a page that has seen no backend. */
export function unbindPage(): void {
  backend = null;
}

export function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options: { headers?: Record<string, string> } = {},
): Promise<T> {
  const headers = { ...options.headers };
  if (backend !== null) headers[BACKEND_HEADER] = String(backend);
  return send<T>(cmd, args, { headers });
}

/**
 * Starts the page over at its first screen. Everything the page held or was waiting to do
 * (stores, event cursor, open panes, a continuation waiting on an answer) ends with it, and so
 * do the route and the per-launch choices (the board's filters) that named things on the box
 * it was for: the next page starts as a relaunch would. What the core is already doing for
 * this page (a request, a transfer) finishes on the backend it was sent to. Never settles:
 * there is nothing for the page that asked to do next.
 */
export function restartPage(): Promise<never> {
  sessionStorage.clear();
  history.replaceState(null, "", location.pathname + location.search);
  location.reload();
  return new Promise(() => {});
}
