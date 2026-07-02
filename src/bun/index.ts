import { Updater } from "electrobun/bun";
import type { EventStreamState } from "../shared/sail-models";
import type { AppInfo } from "../shared/types";
import { SailClient } from "./api/client";
import { resolveConfig } from "./api/config";
import { SailHttp } from "./api/http";
import { defaultEventStreamDeps, EventStream } from "./api/sse";
import { hydrateProcessEnv, resolveShellEnv } from "./shell-env";
import { setActiveTheme } from "./theme-state";
import { AutoUpdater } from "./updater";
import { WindowManager } from "./window-manager";

/**
 * Bun main process entry. Resolves the login-shell environment FIRST (a Finder-
 * launched `.app` has a bare PATH and no LANG), then opens the window, connects
 * the control-plane client + SSE stream, and starts the auto-updater.
 */
const shellEnv = await resolveShellEnv();
hydrateProcessEnv(shellEnv);

const local = await Updater.getLocalInfo();
const appInfo: AppInfo = {
  name: local.name || "Mast",
  version: local.version || "0.0.0",
  channel: local.channel || "dev",
};

const sailConfig = resolveConfig();
const sail = new SailClient(new SailHttp(sailConfig));

let streamState: EventStreamState = "disconnected";
const stream = new EventStream(
  { server: sailConfig.server, token: sailConfig.token },
  defaultEventStreamDeps((limit) => sail.recentEvents(limit).then((r) => r.data)),
);

const windows = new WindowManager({
  appInfo: () => appInfo,
  onTheme: setActiveTheme,
  sail,
  streamState: () => streamState,
  serverUrl: () => sailConfig.server,
});
windows.open();

stream.onEvent((event) => windows.broadcast("sail-event", event));
stream.onState((state) => {
  streamState = state;
  windows.broadcast("sail-stream-state", { state });
});
if (sailConfig.token) void stream.start();

const updater = new AutoUpdater((status, message) => {
  windows.broadcast("update-status", { status, message });
});
updater.start();
