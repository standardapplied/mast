import { ApplicationMenu, Updater, Utils } from "electrobun/bun";
import type { AppInfo } from "../shared/types";
import { SailClient } from "./api/client";
import { resolveConfig, resolveSshHost, writeConfig } from "./api/config";
import { SailApiError, SailHttp } from "./api/http";
import { defaultEventStreamDeps, EventStream } from "./api/sse";
import { defaultServeDeps, startCallbackServer } from "./connect/login-callback";
import { ConnectionManager } from "./connect/manager";
import { pickTunnelPort } from "./connect/ports";
import { TunnelManager } from "./connect/tunnel";
import { installApplicationMenu } from "./menu";
import { hydrateProcessEnv, resolveShellEnv } from "./shell-env";
import { setActiveTheme } from "./theme-state";
import { AutoUpdater } from "./updater";
import { WindowManager } from "./window-manager";

/**
 * Bun main process entry. The window opens IMMEDIATELY — the login-shell
 * environment (a Finder-launched `.app` has a bare PATH and no LANG, and heavy
 * dotfiles take 5-30s to source) resolves in the background; shell-outs (the
 * ssh tunnel) await `shellEnvReady`.
 */
export const shellEnvReady = resolveShellEnv().then((env) => hydrateProcessEnv(env));

const local = await Updater.getLocalInfo();
const appInfo: AppInfo = {
  name: local.name || "Mast",
  version: local.version || "0.0.0",
  channel: local.channel || "dev",
};

let sail = new SailClient(new SailHttp(resolveConfig()));

async function probe(server: string): Promise<boolean> {
  try {
    const response = await fetch(`${server}/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const manager = new ConnectionManager({
  config: resolveConfig,
  sshHost: () => resolveSshHost(),
  probe,
  validateToken: async (server, token) => {
    const config = resolveConfig();
    try {
      await new SailClient(new SailHttp({ ...config, server, token })).board();
      return "ok";
    } catch (error) {
      if (error instanceof SailApiError && (error.status === 401 || error.status === 403)) {
        return "unauthenticated";
      }
      return "unreachable";
    }
  },
  makeTunnel: (host) =>
    new TunnelManager(
      { host },
      {
        spawn: (argv) => {
          const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          return { exited: child.exited, kill: () => child.kill() };
        },
        // ssh needs the login-shell PATH (a Finder-launched .app has a bare
        // one); only the tunnel spawn waits on it, not the whole startup.
        pickPort: () => shellEnvReady.then(() => pickTunnelPort()),
        healthCheck: probe,
        schedule: (fn, ms) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
      },
    ),
  makeStream: (server, token) =>
    new EventStream(
      { server, token },
      defaultEventStreamDeps((limit) => sail.recentEvents(limit).then((r) => r.data)),
    ),
  writeToken: (token) => writeConfig({ token }),
  openExternal: (url) => Utils.openExternal(url),
  startCallback: (state) => startCallbackServer(state, defaultServeDeps()),
  onStack: (server, token) => {
    const config = resolveConfig();
    sail = new SailClient(new SailHttp({ ...config, server, token }));
  },
  onEvent: (event) => windows.broadcast("sail-event", event),
  scheduleSupervisor: (fn) => {
    const timer = setInterval(fn, 5000);
    return () => clearInterval(timer);
  },
});

installApplicationMenu((menu) => ApplicationMenu.setApplicationMenu(menu as never));

const windows = new WindowManager({
  appInfo: () => appInfo,
  onTheme: setActiveTheme,
  sail: () => sail,
  connection: () => manager.currentStatus,
  login: () => manager.login(),
  onAuthError: () => manager.onAuthError(),
  onBeforeQuit: () => manager.stop(),
});
windows.open();

manager.onStatus((status) => windows.broadcast("connection-status", status));
void manager.start();

// The ssh child is not process-grouped; tear it down when the app exits so a
// quit never orphans a tunnel holding the local port.
const shutdown = () => manager.stop();
process.on("exit", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const updater = new AutoUpdater((status, message) => {
  windows.broadcast("update-status", { status, message });
});
updater.start();
