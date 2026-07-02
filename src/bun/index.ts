import { ApplicationMenu, Updater } from "electrobun/bun";
import type { EventStreamState } from "../shared/sail-models";
import type { AppInfo } from "../shared/types";
import { SailClient } from "./api/client";
import { resolveConfig } from "./api/config";
import { SailHttp } from "./api/http";
import { defaultEventStreamDeps, EventStream } from "./api/sse";
import { installApplicationMenu } from "./menu";
import { hydrateProcessEnv, resolveShellEnv } from "./shell-env";
import { setActiveTheme } from "./theme-state";
import { AutoUpdater } from "./updater";
import { WindowManager } from "./window-manager";

/**
 * Bun main process entry. The window opens IMMEDIATELY — the login-shell
 * environment (a Finder-launched `.app` has a bare PATH and no LANG, and heavy
 * dotfiles take 5-30s to source) resolves in the background; only future
 * shell-outs (ssh/rsync/agents) need it, so they await `shellEnvReady`.
 */
export const shellEnvReady = resolveShellEnv().then((env) => hydrateProcessEnv(env));

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

installApplicationMenu((menu) => ApplicationMenu.setApplicationMenu(menu as never));

const windows = new WindowManager({
  appInfo: () => appInfo,
  onTheme: setActiveTheme,
  sail,
  streamState: () => streamState,
  serverUrl: () => sailConfig.server,
  tokenPresent: () => sailConfig.token !== null,
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
