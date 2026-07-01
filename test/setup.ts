import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register a DOM (window/document/CustomEvent/…) for webview tests. The Bun-main
// and pure-logic tests ignore it.
GlobalRegistrator.register();

// React 19's `act()` requires this flag to flush effects synchronously in tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
