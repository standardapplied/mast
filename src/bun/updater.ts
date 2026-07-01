import { Updater } from "electrobun/bun";
import { UPDATE_CHECK_INTERVAL_MS } from "../shared/types";
import { backoffDelay } from "./backoff";

export type UpdateReporter = (status: string, message: string) => void;

/**
 * Periodic auto-update loop over Electrobun's `Updater`. Checks every 30 min;
 * on a failed check it retries with exponential backoff (capped at the normal
 * interval). When an update is downloaded and ready, `applyUpdate()` swaps the
 * bundle and restarts the app. The `dev` channel disables updates upstream, so
 * this is a no-op during local development.
 */
export class AutoUpdater {
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly report: UpdateReporter = () => {},
    private readonly intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
  ) {}

  start(): void {
    Updater.onStatusChange((entry) => this.report(entry.status, entry.message));
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    try {
      const info = await Updater.checkForUpdate();
      if (info.error) throw new Error(info.error);

      this.attempt = 0;

      if (info.updateAvailable) {
        await Updater.downloadUpdate();
        if (Updater.updateInfo()?.updateReady) {
          await Updater.applyUpdate();
          return;
        }
      }

      this.schedule(this.intervalMs);
    } catch (error) {
      this.report("error", error instanceof Error ? error.message : String(error));
      this.schedule(backoffDelay(this.attempt++, { baseMs: 60_000, maxMs: this.intervalMs }));
    }
  }
}
