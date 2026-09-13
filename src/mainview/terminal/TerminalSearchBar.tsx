import type { RefObject } from "react";
import { Cross } from "../components/icons";
import type { SearchState } from "./vtCore";

/**
 * ⌘F: the find bar over a pane. It owns no search state — the needle is the pane's, the counts are
 * the controller's ({@link SearchState}) — and keeps every event to itself, so a keystroke typed
 * here never reaches the shell and a click never starts a selection. Enter steps to the next
 * match, Shift+Enter to the previous, Escape closes. Transport-free, so it renders under `bun test`.
 */

export interface TerminalSearchBarProps {
  readonly needle: string;
  readonly state: SearchState | null;
  /** The input, so the pane can bring a bar that is already open back to it on ⌘F. */
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  readonly onNeedle: (needle: string) => void;
  readonly onStep: (direction: "next" | "prev") => void;
  readonly onClose: () => void;
}

/** What the counter says: k of n once a match is selected, the count while none is, or the state. */
export function counterText(needle: string, state: SearchState | null): string {
  if (needle.length === 0 || state === null) return "";
  if (state.total === 0) return state.status === "complete" ? "No matches" : "Searching…";
  if (state.selected === null) return `${state.total} matches`;
  return `${state.selected + 1} of ${state.total}`;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function TerminalSearchBar({ needle, state, inputRef, onNeedle, onStep, onClose }: TerminalSearchBarProps) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      onStep(e.shiftKey ? "prev" : "next");
      e.preventDefault();
    } else if (e.key === "Escape") {
      onClose();
      e.preventDefault();
    } else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.currentTarget.select();
      e.preventDefault();
    }
  };
  const canStep = (state?.total ?? 0) > 0;
  return (
    <div
      className="term-search"
      data-testid="term-search"
      role="search"
      onKeyDown={stop}
      onKeyUp={stop}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onWheel={stop}
      onPaste={stop}
      onContextMenu={stop}
      onCompositionEnd={stop}
    >
      <input
        ref={inputRef}
        className="term-search__input"
        data-testid="term-search-input"
        type="text"
        value={needle}
        placeholder="Find"
        aria-label="Find in terminal"
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => onNeedle(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="term-search__count" data-testid="term-search-count" aria-live="polite">
        {counterText(needle, state)}
      </span>
      <button
        type="button"
        className="term-search__btn"
        aria-label="Previous match"
        title="Previous match (⇧↩)"
        disabled={!canStep}
        onClick={() => onStep("prev")}
      >
        ↑
      </button>
      <button
        type="button"
        className="term-search__btn"
        aria-label="Next match"
        title="Next match (↩)"
        disabled={!canStep}
        onClick={() => onStep("next")}
      >
        ↓
      </button>
      <button type="button" className="term-search__btn" aria-label="Close find" title="Close (esc)" onClick={onClose}>
        <Cross size={12} />
      </button>
    </div>
  );
}
