import { Updater } from "electrobun/bun";
import type { AppInfo } from "../shared/types";
import { hydrateProcessEnv, resolveShellEnv } from "./shell-env";
import { AutoUpdater } from "./updater";
import { WindowManager } from "./window-manager";

/**
 * Bun main process entry. Resolves the login-shell environment FIRST (a Finder-
 * launched `.app` has a bare PATH and no LANG), then opens the window and starts
 * the auto-updater. Anything that shells out later inherits the correct env.
 */
const shellEnv = await resolveShellEnv();
hydrateProcessEnv(shellEnv);

const local = await Updater.getLocalInfo();
const appInfo: AppInfo = {
  name: local.name || "Mast",
  version: local.version || "0.0.0",
  channel: local.channel || "dev",
};

const windows = new WindowManager(() => appInfo);
windows.open();

const updater = new AutoUpdater((status, message) => {
  windows.broadcast("update-status", { status, message });
});
updater.start();
