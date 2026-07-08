import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Updater } from "../updater";

const RELEASES_URL = "https://github.com/standardapplied/mast/releases";

/**
 * The real updater: `@tauri-apps/plugin-updater` checks the GitHub-release
 * `latest.json` (over the network, not the SSH tunnel), verifies the minisign
 * signature, and swaps the signed+notarized bundle; `@tauri-apps/plugin-process`
 * relaunches into the new version. Downloads report progress as a 0..1 fraction.
 */
export function createTauriUpdater(): Updater {
  return {
    currentVersion: () => getVersion(),

    check: async () => {
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        install: async (onProgress) => {
          let total = 0;
          let downloaded = 0;
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? 0;
              onProgress(total > 0 ? 0 : null);
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              onProgress(total > 0 ? Math.min(1, downloaded / total) : null);
            } else if (event.event === "Finished") {
              onProgress(1);
            }
          });
        },
      };
    },

    relaunch: () => relaunch(),
    openReleases: () => invoke("open_url", { url: RELEASES_URL }),
  };
}
