/**
 * Pane layout for one workspace tab: sub-tabs of terminals, each holding 1..n side-by-side split
 * panes. Every pane is a durable host session, so *existence* is the pty-host's truth (its session
 * list) while *arrangement* is the client's (persisted locally); {@link reconcile} merges the two.
 * Pure data + functions — the React component is a thin edge over these.
 *
 * Naming: a tab's first session is the base name (`mast-node`, `mast-<project>` — unchanged from
 * the single-pane era, so existing sessions become pane 1), and further panes take `<base>.<n>`
 * with the lowest free ordinal. Container names cannot contain dots, so the suffix never collides
 * with another project's base.
 */

/** Session names, grouped: `groups[i]` renders as side-by-side splits; `active` is the open tab. */
export interface PaneLayout {
  readonly groups: ReadonlyArray<readonly string[]>;
  readonly active: number;
}

export function baseSessionFor(target?: string): string {
  return target ? `mast-${target}` : "mast-node";
}

/** What the pty-host's `project` field should be: blank runs on the box, a name in its container. */
export function projectFor(target?: string): string {
  return target ?? "";
}

export function defaultLayout(base: string): PaneLayout {
  return { groups: [[base]], active: 0 };
}

/** The ordinal a session name carries (base = 1), or null when it isn't ours. */
function ordinalOf(session: string, base: string): number | null {
  if (session === base) return 1;
  if (!session.startsWith(`${base}.`)) return null;
  const n = Number(session.slice(base.length + 1));
  return Number.isInteger(n) && n >= 2 ? n : null;
}

export function labelFor(session: string, base: string): string {
  return String(ordinalOf(session, base) ?? "?");
}

/** The lowest-free-ordinal name for a fresh pane, given every name already spoken for. */
export function nextSessionName(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}.${n}`;
    if (!used.has(name)) return name;
  }
}

/**
 * Merges the stored arrangement with the host's live session list. Stored panes are kept even when
 * their session died — reopening the tab recreates the shell in place, which is how a layout
 * survives a host reboot. Live sessions the client has never seen (opened from another Mac, or an
 * older client) are appended as their own tabs in ordinal order. Anything on the socket that isn't
 * this tab's base or `base.<n>` is someone else's and is ignored.
 */
export function reconcile(
  stored: PaneLayout | null,
  live: readonly string[],
  base: string,
): PaneLayout {
  const groups = (stored?.groups ?? [])
    .map((g) => g.filter((s) => ordinalOf(s, base) !== null))
    .filter((g) => g.length > 0)
    .map((g) => [...g]);
  const seen = new Set(groups.flat());
  const strays = live
    .filter((s) => ordinalOf(s, base) !== null && !seen.has(s))
    .sort((a, b) => ordinalOf(a, base)! - ordinalOf(b, base)!);
  for (const s of strays) {
    groups.push([s]);
  }
  if (groups.length === 0) {
    return defaultLayout(base);
  }
  const active = Math.min(Math.max(stored?.active ?? 0, 0), groups.length - 1);
  return { groups, active };
}

/** A fresh pane in its own tab, focused. */
export function newGroup(layout: PaneLayout, session: string): PaneLayout {
  return { groups: [...layout.groups, [session]], active: layout.groups.length };
}

/** A fresh pane split into an existing tab. */
export function splitGroup(layout: PaneLayout, group: number, session: string): PaneLayout {
  return {
    groups: layout.groups.map((g, i) => (i === group ? [...g, session] : g)),
    active: layout.active,
  };
}

/** Removes a pane; an emptied tab disappears, and removing the very last pane restores the default. */
export function removePane(layout: PaneLayout, session: string, base: string): PaneLayout {
  const groups = layout.groups
    .map((g) => g.filter((s) => s !== session))
    .filter((g) => g.length > 0);
  if (groups.length === 0) {
    return defaultLayout(base);
  }
  return { groups, active: Math.min(layout.active, groups.length - 1) };
}

export function paneCount(layout: PaneLayout): number {
  return layout.groups.reduce((n, g) => n + g.length, 0);
}

export function sessionsOf(layout: PaneLayout): string[] {
  return layout.groups.flatMap((g) => [...g]);
}
