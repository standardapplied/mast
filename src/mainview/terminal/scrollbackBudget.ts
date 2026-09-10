/**
 * How much scrollback a terminal keeps, in MiB. libghostty allocates it only as output
 * accumulates, so the budget is a ceiling on what a chatty session can pin per pane, not a cost
 * paid up front. Applied when a terminal is created; panes already open keep theirs. The one owner
 * of the setting, in the presenceStore mold: a class singleton components read through
 * `useSyncExternalStore`, persisted under {@link STORAGE_KEY} (a preference, never existence).
 */

export const SCROLLBACK_CHOICES_MIB = [5, 20, 50] as const;
export type ScrollbackMib = (typeof SCROLLBACK_CHOICES_MIB)[number];

export const DEFAULT_SCROLLBACK_MIB: ScrollbackMib = 20;
export const STORAGE_KEY = "mast.terminal.scrollback-mib";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const isChoice = (value: number): value is ScrollbackMib =>
  (SCROLLBACK_CHOICES_MIB as readonly number[]).includes(value);

class ScrollbackBudgetStore {
  private current: ScrollbackMib = DEFAULT_SCROLLBACK_MIB;
  private storage: Storage | null = null;
  private readonly listeners = new Set<() => void>();

  /** Seeds the setting from persistent storage; every later change is written back there. */
  connect(storage: Storage): void {
    this.storage = storage;
    const stored = Number(storage.getItem(STORAGE_KEY));
    this.current = isChoice(stored) ? stored : DEFAULT_SCROLLBACK_MIB;
    this.emit();
  }

  readonly mib = (): ScrollbackMib => this.current;

  /** The budget a terminal created now is given. */
  bytes(): number {
    return this.current * 1024 * 1024;
  }

  set(mib: ScrollbackMib): void {
    if (mib === this.current) return;
    this.current = mib;
    this.storage?.setItem(STORAGE_KEY, String(mib));
    this.emit();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Test seam: back to the default with no storage attached. */
  reset(): void {
    this.storage = null;
    this.current = DEFAULT_SCROLLBACK_MIB;
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const scrollbackBudget = new ScrollbackBudgetStore();
