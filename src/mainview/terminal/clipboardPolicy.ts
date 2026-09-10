/**
 * Whether a program in the terminal may write the system clipboard (OSC 52). Allowed by default
 * — parity with Ghostty and the shipped copy flow — with the write always announced in the pane;
 * "deny" refuses it and the program hears DENIED where the protocol replies. The one owner of the
 * setting, in the presenceStore mold: a class singleton components read through
 * `useSyncExternalStore`, persisted under {@link STORAGE_KEY} (a preference, never existence).
 */

export type ClipboardWrite = "allow" | "deny";

export const STORAGE_KEY = "mast.terminal.clipboard-write";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const isMode = (value: unknown): value is ClipboardWrite => value === "allow" || value === "deny";

class ClipboardPolicyStore {
  private current: ClipboardWrite = "allow";
  private storage: Storage | null = null;
  private readonly listeners = new Set<() => void>();

  /** Seeds the setting from persistent storage; every later change is written back there. */
  connect(storage: Storage): void {
    this.storage = storage;
    const stored = storage.getItem(STORAGE_KEY);
    this.current = isMode(stored) ? stored : "allow";
    this.emit();
  }

  readonly mode = (): ClipboardWrite => this.current;

  set(mode: ClipboardWrite): void {
    if (mode === this.current) return;
    this.current = mode;
    this.storage?.setItem(STORAGE_KEY, mode);
    this.emit();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Test seam: back to the default with no storage attached. */
  reset(): void {
    this.storage = null;
    this.current = "allow";
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const clipboardPolicy = new ClipboardPolicyStore();
