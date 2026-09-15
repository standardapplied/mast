import { useRef, useState } from "react";

/**
 * The chip's in-place rename: an input where the title was. Enter commits, Escape cancels, blur
 * commits, and an empty name clears the label back to the live title. Every event stays here —
 * a letter typed into the name never reaches the shell, and ⌘W never reaches the bar's chords.
 * Transport-free, so it renders under `bun test`.
 */

export interface PaneChipEditProps {
  /** The custom label the pane has now, blank when it is named by its live title. */
  readonly initial: string;
  /** What the pane is called without a label — shown as the placeholder. */
  readonly placeholder: string;
  readonly onCommit: (label: string) => void;
  readonly onCancel: () => void;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function PaneChipEdit({ initial, placeholder, onCommit, onCancel }: PaneChipEditProps) {
  const [value, setValue] = useState(initial);
  // Settled once: Escape unmounts the input, and the blur that follows must not commit.
  const settled = useRef(false);
  const finish = (done: () => void) => {
    if (settled.current) return;
    settled.current = true;
    done();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    // Enter and Escape mid-composition confirm or cancel the IME's candidate, not the name.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      finish(() => onCommit(value.trim()));
      e.preventDefault();
    } else if (e.key === "Escape") {
      finish(onCancel);
      e.preventDefault();
    }
  };
  return (
    <input
      className="term-pane-chip__edit"
      data-testid="term-pane-chip-edit"
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label="Pane name"
      autoFocus
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onKeyUp={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onPaste={stop}
      onCompositionEnd={stop}
      onBlur={() => finish(() => onCommit(value.trim()))}
    />
  );
}
