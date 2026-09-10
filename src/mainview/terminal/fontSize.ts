/**
 * The terminal font size, in CSS pixels. ⌘+/⌘−/⌘0 walk {@link TERMINAL_FONT_SIZES_PX} and every
 * pane follows live: its renderer is rebuilt on the atlas for the new size (one per size, shared),
 * the cell comes back out of the face's metrics, and the grid refits, so the program reflows
 * without a reconnect. The one owner of the setting, in the presenceStore mold: a class singleton
 * components read through `useSyncExternalStore`, persisted under {@link STORAGE_KEY} (an
 * arrangement, never existence).
 */

import { TERMINAL_FONT_PX } from "./metrics";

export const TERMINAL_FONT_SIZES_PX = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32] as const;
export type TerminalFontPx = (typeof TERMINAL_FONT_SIZES_PX)[number];
export type ZoomStep = "in" | "out" | "reset";

export const DEFAULT_TERMINAL_FONT_PX: TerminalFontPx = TERMINAL_FONT_PX;
export const STORAGE_KEY = "mast.terminal.font-px";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const isSize = (value: number): value is TerminalFontPx =>
  (TERMINAL_FONT_SIZES_PX as readonly number[]).includes(value);

class TerminalFontSizeStore {
  private current: TerminalFontPx = DEFAULT_TERMINAL_FONT_PX;
  private storage: Storage | null = null;
  private readonly listeners = new Set<() => void>();

  /** Seeds the setting from persistent storage; every later change is written back there. */
  connect(storage: Storage): void {
    this.storage = storage;
    const stored = Number(storage.getItem(STORAGE_KEY));
    this.current = isSize(stored) ? stored : DEFAULT_TERMINAL_FONT_PX;
    this.emit();
  }

  readonly px = (): TerminalFontPx => this.current;

  set(px: TerminalFontPx): void {
    if (px === this.current) return;
    this.current = px;
    this.storage?.setItem(STORAGE_KEY, String(px));
    this.emit();
  }

  /** One rung up or down the ladder (the ends hold), or back to the default. */
  zoom(step: ZoomStep): void {
    if (step === "reset") return this.set(DEFAULT_TERMINAL_FONT_PX);
    const at = TERMINAL_FONT_SIZES_PX.indexOf(this.current);
    const next = TERMINAL_FONT_SIZES_PX[at + (step === "in" ? 1 : -1)];
    if (next !== undefined) this.set(next);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Test seam: back to the default with no storage attached. */
  reset(): void {
    this.storage = null;
    this.current = DEFAULT_TERMINAL_FONT_PX;
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const terminalFontSize = new TerminalFontSizeStore();
