/**
 * Per-project workbench pane widths, persisted so a splitter drag survives a
 * remount (today `treeWidth` resets every mount). Storage is injected so the
 * clamp/parse rules are unit-testable.
 */

export type PaneWidths = { tree: number; viewer: number };

export const PANE_LIMITS = {
  tree: { min: 200, max: 640 },
  viewer: { min: 320, max: 1400 },
} as const;

export const DEFAULT_WIDTHS: PaneWidths = { tree: 320, viewer: 560 };

type KV = Pick<Storage, "getItem" | "setItem">;

const key = (target: string) => `mast.workbench.${target}`;

export function clampPane(pane: keyof PaneWidths, width: number): number {
  const { min, max } = PANE_LIMITS[pane];
  return Math.min(max, Math.max(min, Math.round(width)));
}

export function loadWidths(storage: KV, target: string): PaneWidths {
  try {
    const raw = storage.getItem(key(target));
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    return {
      tree: clampPane("tree", typeof parsed.tree === "number" ? parsed.tree : DEFAULT_WIDTHS.tree),
      viewer: clampPane(
        "viewer",
        typeof parsed.viewer === "number" ? parsed.viewer : DEFAULT_WIDTHS.viewer,
      ),
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

export function saveWidths(storage: KV, target: string, widths: PaneWidths): void {
  storage.setItem(key(target), JSON.stringify(widths));
}
