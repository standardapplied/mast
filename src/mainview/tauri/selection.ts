/**
 * Multi-select model for the file explorer, pure so every gesture is
 * unit-testable: plain click = single select, cmd/ctrl-click toggles,
 * shift-click ranges over the *visible* rows from the anchor, Esc clears.
 */

export type Selection = {
  paths: ReadonlySet<string>;
  /** Where a shift-range starts — the last plainly-clicked/toggled path. */
  anchor: string | null;
  /** The keyboard cursor — the last path acted on. */
  focus: string | null;
};

export const EMPTY_SELECTION: Selection = { paths: new Set(), anchor: null, focus: null };

export function clearSelection(): Selection {
  return EMPTY_SELECTION;
}

export function click(_sel: Selection, path: string): Selection {
  return { paths: new Set([path]), anchor: path, focus: path };
}

export function toggle(sel: Selection, path: string): Selection {
  const paths = new Set(sel.paths);
  if (paths.has(path)) {
    paths.delete(path);
    const anchor = sel.anchor === path ? null : sel.anchor;
    return { paths, anchor: paths.size === 0 ? null : anchor, focus: paths.size === 0 ? null : path };
  }
  paths.add(path);
  return { paths, anchor: path, focus: path };
}

export function rangeTo(sel: Selection, visible: readonly string[], path: string): Selection {
  const from = sel.anchor === null ? -1 : visible.indexOf(sel.anchor);
  if (from === -1) return click(sel, path);
  const to = visible.indexOf(path);
  if (to === -1) return click(sel, path);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { paths: new Set(visible.slice(lo, hi + 1)), anchor: sel.anchor, focus: path };
}
