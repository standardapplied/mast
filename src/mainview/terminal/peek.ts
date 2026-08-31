/**
 * The deck trigger's hover-peek state machine. Click is primary and pins the
 * popover; hovering peeks it after a short delay, and a peeked popover stays up
 * while the pointer is inside the trigger or the panel — the generous grace
 * path that keeps a trackpad's wobble from flickering it. Pure logic with an
 * injected scheduler so tests drive time by hand.
 */

export type PeekState = "closed" | "peek" | "pinned";

/** Schedules fn after ms; returns the cancel. Defaults to setTimeout. */
export type PeekScheduler = (fn: () => void, ms: number) => () => void;

const timeoutScheduler: PeekScheduler = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export const PEEK_OPEN_DELAY_MS = 350;
export const PEEK_CLOSE_DELAY_MS = 300;

export type Peek = {
  state(): PeekState;
  /** Pointer entered the trigger: arm the delayed peek, cancel a pending close. */
  enterTrigger(): void;
  /** Pointer entered the panel: the grace path — a pending close is forgiven. */
  enterPanel(): void;
  /** Pointer left the trigger or the panel: a peek closes after the grace delay. */
  leave(): void;
  /** Click toggles the pin: closed/peek → pinned, pinned → closed. */
  click(): void;
  /** Outside click or Escape: close regardless of pin. */
  dismiss(): void;
  dispose(): void;
};

export function createPeek(
  onChange: (state: PeekState) => void,
  schedule: PeekScheduler = timeoutScheduler,
): Peek {
  let state: PeekState = "closed";
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
  };
  const set = (next: PeekState) => {
    if (state === next) return;
    state = next;
    onChange(next);
  };

  return {
    state: () => state,
    enterTrigger() {
      cancel();
      if (state !== "closed") return;
      cancelPending = schedule(() => {
        cancelPending = null;
        set("peek");
      }, PEEK_OPEN_DELAY_MS);
    },
    enterPanel() {
      cancel();
    },
    leave() {
      cancel();
      if (state !== "peek") return;
      cancelPending = schedule(() => {
        cancelPending = null;
        set("closed");
      }, PEEK_CLOSE_DELAY_MS);
    },
    click() {
      cancel();
      set(state === "pinned" ? "closed" : "pinned");
    },
    dismiss() {
      cancel();
      set("closed");
    },
    dispose: cancel,
  };
}
