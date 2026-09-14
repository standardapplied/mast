import { logError } from "../errorLog";
import type { AttentionRequest } from "./terminalServices";

/**
 * A bell you can hear when you are not looking. The one owner of everything a BEL reaches beyond
 * the pane's own flash, in the presenceStore mold: the set of panes that rang unseen (the chip
 * dot and the Dock badge both derive from it, so they can never disagree) and the setting for how
 * an unseen bell rings, persisted under {@link STORAGE_KEY} (a preference, never existence).
 *
 * Ghostty's focus rule: a bell rings only when the ringing pane is not the focused pane or the
 * window is not focused; a focused pane in the frontmost window keeps the flash and nothing more.
 * A muted pane flashes only. A program looping BEL rings at most once per {@link RING_COALESCE_MS}
 * per pane — coalesced, never queued. The badge is the size of the unseen set, none at zero, and
 * is corrected on every change to that set whatever the coalescing says.
 */

export type BellSetting = "sound+bounce" | "sound" | "bounce" | "flash";

export const BELL_SETTINGS: readonly BellSetting[] = ["sound+bounce", "sound", "bounce", "flash"];

export const STORAGE_KEY = "mast.terminal.bell";

export const RING_COALESCE_MS = 2000;

export interface BellFacts {
  readonly paneFocused: boolean;
  readonly windowFocused: boolean;
  readonly muted: boolean;
}

export interface Ring {
  readonly sound: boolean;
  readonly bounce: boolean;
}

/** How an unseen bell rings under the setting, or null when the bell flashes only. */
export function attentionFor(setting: BellSetting, facts: BellFacts): Ring | null {
  if (facts.muted || (facts.paneFocused && facts.windowFocused)) return null;
  return {
    sound: setting === "sound+bounce" || setting === "sound",
    bounce: setting === "sound+bounce" || setting === "bounce",
  };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Attention = (request: AttentionRequest) => Promise<void>;

const isSetting = (value: unknown): value is BellSetting => BELL_SETTINGS.includes(value as BellSetting);

class AttentionStore {
  private setting: BellSetting = "sound+bounce";
  private unseenSet: ReadonlySet<string> = new Set();
  private readonly lastRing = new Map<string, number>();
  private storage: Storage | null = null;
  private attention: Attention | null = null;
  private now: () => number = Date.now;
  private readonly listeners = new Set<() => void>();

  /** Seeds the setting from storage and takes the transport every ring and badge goes through. */
  connect(storage: Storage, attention: Attention, now: () => number = Date.now): void {
    this.storage = storage;
    this.attention = attention;
    this.now = now;
    const stored = storage.getItem(STORAGE_KEY);
    this.setting = isSetting(stored) ? stored : "sound+bounce";
    this.emit();
  }

  readonly bell = (): BellSetting => this.setting;

  setBell(setting: BellSetting): void {
    if (setting === this.setting) return;
    this.setting = setting;
    this.storage?.setItem(STORAGE_KEY, setting);
    this.emit();
  }

  /** Panes that rang while not the focused pane of a focused window, until they are. */
  readonly unseen = (): ReadonlySet<string> => this.unseenSet;

  /** The program in `session` rang the bell; the pane has already flashed. */
  ring(session: string, facts: BellFacts): void {
    const ring = attentionFor(this.setting, facts);
    if (ring === null) return;
    const now = this.now();
    const last = this.lastRing.get(session);
    const due = last === undefined || now - last >= RING_COALESCE_MS;
    if (due) this.lastRing.set(session, now);
    const added = !this.unseenSet.has(session);
    if (added) this.replace(new Set(this.unseenSet).add(session));
    if (due) this.act(ring);
    else if (added) this.act({ sound: false, bounce: false });
  }

  /** `session` became the focused pane of a focused window: its ring is seen. */
  seen(session: string): void {
    this.drop([session]);
  }

  /** Panes that no longer exist ring nothing and owe no badge. */
  forget(sessions: readonly string[]): void {
    for (const session of sessions) this.lastRing.delete(session);
    this.drop(sessions);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Test seam: back to the default with nothing attached and nothing unseen. */
  reset(): void {
    this.storage = null;
    this.attention = null;
    this.now = Date.now;
    this.setting = "sound+bounce";
    this.unseenSet = new Set();
    this.lastRing.clear();
    this.emit();
  }

  private drop(sessions: readonly string[]): void {
    if (!sessions.some((s) => this.unseenSet.has(s))) return;
    const next = new Set(this.unseenSet);
    for (const session of sessions) next.delete(session);
    this.replace(next);
    this.act({ sound: false, bounce: false });
  }

  private replace(next: ReadonlySet<string>): void {
    this.unseenSet = next;
    this.emit();
  }

  private act(ring: Ring): void {
    const badge = this.unseenSet.size > 0 ? this.unseenSet.size : null;
    this.attention?.({ ...ring, badge }).catch((e: unknown) => {
      logError("attention", e instanceof Error ? e.message : String(e));
    });
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const attentionStore = new AttentionStore();
