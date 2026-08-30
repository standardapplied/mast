import type { MenuNode } from "../components/ContextMenu";
import { type PaneGroup, type PaneLayout, titleOf } from "./paneLayout";

/**
 * The shell context menus — one tested builder for both the pane's right-click extras and the
 * chip's menu, so composition (order, separators, closable gating, which pane a chip targets)
 * is pinned by tests instead of living in JSX. Transport-free: callers inject the actions.
 */

/** The swatches a shell can wear (ghostty-style tab dots) — index is what the layout stores. */
export const PANE_COLORS = [
  "#fc4926",
  "#e0a24d",
  "#e8d44d",
  "#86b89a",
  "#4de0c8",
  "#5b9bd5",
  "#a78bfa",
  "#d08fa6",
] as const;

export interface PaneMenuActions {
  rename(session: string): void;
  setColor(session: string, color: number | undefined): void;
  close(sessions: string[]): void;
}

/** Rename + Color for one shell. */
export function identityItems(session: string, actions: PaneMenuActions): MenuNode[] {
  return [
    {
      kind: "item",
      label: "Rename shell…",
      onSelect: () => actions.rename(session),
    },
    {
      kind: "item",
      label: "Color",
      submenu: [
        {
          kind: "item",
          label: "None",
          onSelect: () => actions.setColor(session, undefined),
        },
        ...PANE_COLORS.map((hex, index) => ({
          kind: "item" as const,
          label: (
            <>
              <span className="term-pane-dot" style={{ background: hex }} aria-hidden />
              {`Color ${index + 1}`}
            </>
          ),
          onSelect: () => actions.setColor(session, index),
        })),
      ],
    },
  ];
}

/** The pane's context-menu extras: identity, then Close pane (closing the last one = a fresh shell). */
export function paneMenuItems(
  layout: PaneLayout,
  session: string,
  base: string,
  actions: PaneMenuActions,
  titles?: Readonly<Record<string, string>>,
): MenuNode[] {
  return [
    ...identityItems(session, actions),
    {
      kind: "item" as const,
      label: `Close pane ${titleOf(layout, session, base, titles)}`,
      danger: true,
      onSelect: () => actions.close([session]),
    },
  ];
}

/**
 * The chip's menu: identity for the group's focused pane (first when focus is elsewhere), then
 * Close shell for the whole group.
 */
export function chipMenuItems(
  layout: PaneLayout,
  group: PaneGroup,
  focused: string,
  base: string,
  actions: PaneMenuActions,
  titles?: Readonly<Record<string, string>>,
): MenuNode[] {
  const target = group.panes.includes(focused) ? focused : group.panes[0]!;
  const label = group.panes.map((s) => titleOf(layout, s, base, titles)).join("·");
  return [
    ...identityItems(target, actions),
    { kind: "separator" } as MenuNode,
    {
      kind: "item" as const,
      label: `Close shell ${label}`,
      danger: true,
      onSelect: () => actions.close([...group.panes]),
    },
  ];
}
