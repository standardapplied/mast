import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Bun's real fetch/Response, captured BEFORE happy-dom replaces the globals —
 * Bun-main tests that exercise real HTTP (Bun.serve mocks) must use these;
 * happy-dom's fetch stack cannot talk to Bun.serve reliably.
 */
export const native = {
  fetch: globalThis.fetch,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
};

// Register a DOM (window/document/CustomEvent/…) for webview tests. The Bun-main
// and pure-logic tests ignore it.
GlobalRegistrator.register();

// React 19's `act()` requires this flag to flush effects synchronously in tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
