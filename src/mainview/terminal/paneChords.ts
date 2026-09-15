/**
 * The ⌘ chords that run the pane bar (Ghostty's defaults): ⌘T new shell, ⌘D split, ⌘1…⌘8 a
 * group by number, ⌘9 the last, ⌘⇧[ / ⌘⇧] the previous / next group, ⌘⌥← / ⌘⌥→ the previous /
 * next split, ⌘W close the focused pane, ⌘⇧W close the group. One classifier for both sides of
 * the bubble: the pane yields a chord to its host without encoding it (whatever kitty mode the
 * program pushed), and the host runs it. Brackets, digits and arrows match on the physical key
 * so a non-US layout binds the same way; letters match on what the layout produced.
 *
 * Modifier discipline: plain ⌘ arrows stay the pane's to swallow, ⌥-only chords stay the pty's
 * Option encoding, and ⌘⌥↑/↓ are left for vertical stacking — so nothing here answers them.
 */

export type PaneChord =
  | { readonly kind: "new" }
  | { readonly kind: "split" }
  | { readonly kind: "group"; readonly index: number }
  | { readonly kind: "lastGroup" }
  | { readonly kind: "cycleGroup"; readonly delta: 1 | -1 }
  | { readonly kind: "focusPane"; readonly delta: 1 | -1 }
  | { readonly kind: "closePane" }
  | { readonly kind: "closeGroup" };

export interface ChordKeys {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function paneChordOf(e: ChordKeys): PaneChord | null {
  if (!e.metaKey || e.ctrlKey) return null;
  if (e.altKey) {
    if (e.shiftKey) return null;
    if (e.code === "ArrowLeft") return { kind: "focusPane", delta: -1 };
    if (e.code === "ArrowRight") return { kind: "focusPane", delta: 1 };
    return null;
  }
  const letter = e.key.length === 1 ? e.key.toLowerCase() : "";
  if (e.shiftKey) {
    if (e.code === "BracketLeft") return { kind: "cycleGroup", delta: -1 };
    if (e.code === "BracketRight") return { kind: "cycleGroup", delta: 1 };
    if (letter === "w") return { kind: "closeGroup" };
  } else {
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit === "9") return { kind: "lastGroup" };
    if (digit) return { kind: "group", index: Number(digit) - 1 };
    if (letter === "w") return { kind: "closePane" };
  }
  if (letter === "t") return { kind: "new" };
  if (letter === "d") return { kind: "split" };
  return null;
}
