import type { AppPushMessages } from "../shared/types";

/**
 * Bun → webview push messages are re-dispatched into the DOM as
 * `rpc:<name>` CustomEvents so any React component can subscribe with a plain
 * `addEventListener`, decoupled from the RPC transport entirely.
 */
export function dispatchPush<K extends keyof AppPushMessages & string>(
  name: K,
  payload: AppPushMessages[K],
  target: EventTarget = window,
): void {
  target.dispatchEvent(new CustomEvent(`rpc:${name}`, { detail: payload }));
}

/** Subscribe to a re-dispatched push message. Returns an unsubscribe fn. */
export function onPush<K extends keyof AppPushMessages & string>(
  name: K,
  handler: (payload: AppPushMessages[K]) => void,
  target: EventTarget = window,
): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<AppPushMessages[K]>).detail);
  target.addEventListener(`rpc:${name}`, listener);
  return () => target.removeEventListener(`rpc:${name}`, listener);
}
