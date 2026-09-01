/**
 * Pane layout for one workspace tab: sub-tabs of terminals, each holding 1..n side-by-side split
 * panes. Every pane is a durable host session, so *existence* is the pty-host's truth (its session
 * list) while *arrangement* is the client's (persisted locally); {@link reconcile} merges the two.
 * Pure data + functions — the React component is a thin edge over these.
 *
 * Groups carry a stable numeric id (minted from `seq`), never derived from their member sessions:
 * a group keyed by its first pane would change identity when that pane closes, unmounting — and
 * detaching — the surviving siblings.
 *
 * Naming: a tab's first session is the base name (`mast-node`, `mast-<project>` — unchanged from
 * the single-pane era, so existing sessions become pane 1), and further panes take `<base>.<n>`
 * with the lowest free ordinal. Container names cannot contain dots, so the suffix never collides
 * with another project's base.
 */

export interface PaneGroup {
  readonly id: number;
  readonly panes: readonly string[];
}

/** A pane's optional identity: a custom name and a swatch index (see the component's palette). */
export interface PaneMeta {
  readonly label?: string;
  readonly color?: number;
}

/** `groups[i]` renders as side-by-side splits; `active` is the open sub-tab; `seq` mints ids. */
export interface PaneLayout {
  readonly groups: readonly PaneGroup[];
  readonly active: number;
  readonly seq: number;
  readonly meta?: Readonly<Record<string, PaneMeta>>;
}

export function baseSessionFor(target?: string): string {
  return target ? `mast-${target}` : "mast-node";
}

/** What the pty-host's `project` field should be: blank runs on the box, a name in its container. */
export function projectFor(target?: string): string {
  return target ?? "";
}

export function defaultLayout(base: string): PaneLayout {
  return { groups: [{ id: 1, panes: [base] }], active: 0, seq: 2 };
}

/** The ordinal a session name carries (base = 1), or null when it isn't ours. */
function ordinalOf(session: string, base: string): number | null {
  if (session === base) return 1;
  if (!session.startsWith(`${base}.`)) return null;
  const n = Number(session.slice(base.length + 1));
  return Number.isInteger(n) && n >= 2 ? n : null;
}

/** A pane's ordinal label, or the raw name for an adopted foreign session (`resume-*`). */
export function labelFor(session: string, base: string): string {
  const ordinal = ordinalOf(session, base);
  return ordinal === null ? session : String(ordinal);
}

/** What a pane is called: custom label first, then its live shell title, then the ordinal. */
export function titleOf(
  layout: PaneLayout,
  session: string,
  base: string,
  live?: Readonly<Record<string, string>>,
): string {
  return layout.meta?.[session]?.label || live?.[session] || labelFor(session, base);
}

/**
 * Distills a shell's OSC title into a chip-sized name. The stock bash PS1 emits
 * `user@host: dir` — the directory's last segment is the part a human scans for (ghostty's
 * convention); anything else is shown as-is, trimmed and capped.
 */
export function shortTitle(raw: string): string {
  const trimmed = raw.trim();
  const afterColon = trimmed.match(/^\S+@\S+:\s*(.+)$/)?.[1];
  const path = afterColon?.trim();
  const name = path ? (path === "/" ? "/" : (path.split("/").filter(Boolean).pop() ?? path)) : trimmed;
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/**
 * Sets a pane's identity, merging with what it had: a blank label clears the name, an undefined
 * color clears the swatch, and an identity emptied of both disappears entirely.
 */
export function withPaneMeta(layout: PaneLayout, session: string, patch: PaneMeta): PaneLayout {
  const merged: { label?: string; color?: number } = { ...layout.meta?.[session] };
  if ("label" in patch) {
    if (patch.label) merged.label = patch.label;
    else delete merged.label;
  }
  if ("color" in patch) {
    if (patch.color !== undefined) merged.color = patch.color;
    else delete merged.color;
  }
  const meta = { ...layout.meta };
  if (merged.label === undefined && merged.color === undefined) {
    delete meta[session];
  } else {
    meta[session] = merged;
  }
  return { ...layout, meta: Object.keys(meta).length > 0 ? meta : undefined };
}

/** The stored identities restricted to panes that still exist. */
function pruneMeta(
  meta: Readonly<Record<string, PaneMeta>> | undefined,
  survivors: ReadonlySet<string>,
): Readonly<Record<string, PaneMeta>> | undefined {
  if (!meta) return undefined;
  const kept = Object.fromEntries(Object.entries(meta).filter(([s]) => survivors.has(s)));
  return Object.keys(kept).length > 0 ? kept : undefined;
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
 * Strictly validates a persisted layout. A malformed value (older format, corruption) must read as
 * "nothing stored", never throw downstream — a poisoned localStorage entry would otherwise blank
 * the terminal tab on every mount with no self-heal.
 */
export function parseLayout(raw: string | null): PaneLayout | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { groups?: unknown; active?: unknown; seq?: unknown; meta?: unknown };
    const sound =
      Array.isArray(p.groups) &&
      p.groups.every(
        (g: { id?: unknown; panes?: unknown }) =>
          g !== null &&
          typeof g === "object" &&
          typeof g.id === "number" &&
          Array.isArray(g.panes) &&
          g.panes.length > 0 &&
          g.panes.every((s: unknown) => typeof s === "string"),
      ) &&
      typeof p.active === "number" &&
      typeof p.seq === "number";
    if (!sound) return null;
    // Identity is decoration: a garbled meta heals to none rather than blanking the layout.
    const metaSound =
      p.meta !== undefined &&
      p.meta !== null &&
      typeof p.meta === "object" &&
      Object.values(p.meta as Record<string, unknown>).every(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          ((m as PaneMeta).label === undefined || typeof (m as PaneMeta).label === "string") &&
          ((m as PaneMeta).color === undefined || typeof (m as PaneMeta).color === "number"),
      );
    if (!metaSound) delete p.meta;
    return p as unknown as PaneLayout;
  } catch {
    return null;
  }
}

/**
 * Merges the stored arrangement with the host's live session list. Stored panes are kept even when
 * their session died — reopening the tab recreates the shell in place, which is how a layout
 * survives a host reboot. That recreate-on-absent survives only without a death record: a name in
 * `dead` that the host no longer lists at all (not in `live` or `adopt`) was watched dying, and
 * keeping its pane would resurrect a session the user deliberately killed — it is pruned instead
 * (persistence stores arrangement, never existence). Live sessions the client has never seen
 * (opened from another Mac, or an older client) are appended as their own tabs in ordinal order.
 * Anything on the socket that isn't this tab's base or `base.<n>` is someone else's and is
 * ignored — except names in `adopt`, which belong to this scope despite foreign naming (a room's
 * `resume-*` agent sessions) and are appended after the ordinal strays, in name order.
 */
export function reconcile(
  stored: PaneLayout | null,
  live: readonly string[],
  base: string,
  adopt?: ReadonlySet<string>,
  dead?: ReadonlySet<string>,
): PaneLayout {
  const ours = (s: string) => ordinalOf(s, base) !== null || (adopt?.has(s) ?? false);
  const listed = new Set([...live, ...(adopt ?? [])]);
  const keep = (s: string) => ours(s) && !(dead?.has(s) && !listed.has(s));
  const groups: PaneGroup[] = (stored?.groups ?? [])
    .map((g) => ({ id: g.id, panes: g.panes.filter(keep) }))
    .filter((g) => g.panes.length > 0);
  let seq = Math.max(stored?.seq ?? 1, ...groups.map((g) => g.id + 1));
  const seen = new Set(groups.flatMap((g) => g.panes));
  const strays = live
    .filter((s) => ours(s) && !seen.has(s))
    .sort(
      (a, b) =>
        (ordinalOf(a, base) ?? Infinity) - (ordinalOf(b, base) ?? Infinity) ||
        a.localeCompare(b),
    );
  for (const s of strays) {
    groups.push({ id: seq++, panes: [s] });
  }
  if (groups.length === 0) {
    return defaultLayout(base);
  }
  const active = Math.min(Math.max(stored?.active ?? 0, 0), groups.length - 1);
  const meta = pruneMeta(stored?.meta, new Set(groups.flatMap((g) => g.panes)));
  return meta ? { groups, active, seq, meta } : { groups, active, seq };
}

/** A fresh pane in its own sub-tab, focused. */
export function newGroup(layout: PaneLayout, session: string): PaneLayout {
  return {
    ...layout,
    groups: [...layout.groups, { id: layout.seq, panes: [session] }],
    active: layout.groups.length,
    seq: layout.seq + 1,
  };
}

/** A fresh pane split into an existing sub-tab. */
export function splitGroup(layout: PaneLayout, group: number, session: string): PaneLayout {
  return {
    ...layout,
    groups: layout.groups.map((g, i) => (i === group ? { ...g, panes: [...g.panes, session] } : g)),
  };
}

/** Removes a pane; an emptied sub-tab disappears, and removing the very last pane restores the default. */
export function removePane(layout: PaneLayout, session: string, base: string): PaneLayout {
  const groups = layout.groups
    .map((g) => ({ ...g, panes: g.panes.filter((s) => s !== session) }))
    .filter((g) => g.panes.length > 0);
  if (groups.length === 0) {
    return defaultLayout(base);
  }
  const meta = pruneMeta(layout.meta, new Set(groups.flatMap((g) => g.panes)));
  const next: PaneLayout = { groups, active: Math.min(layout.active, groups.length - 1), seq: layout.seq };
  return meta ? { ...next, meta } : next;
}

/**
 * Removes a set of panes at once. When the removal empties the layout, the healed
 * default pane is the base session — except with `parkLast`, where the first removed
 * session stays instead: a room's close is a kill, and keeping the killed name lets
 * the listing refresh park it on its ended card rather than the healed base name
 * silently creating a replacement shell.
 */
export function removePanes(
  layout: PaneLayout,
  sessions: readonly string[],
  base: string,
  parkLast = false,
): PaneLayout {
  const emptied = sessionsOf(layout).every((s) => sessions.includes(s));
  const fallback = parkLast && emptied ? (sessions[0] ?? base) : base;
  return sessions.reduce((acc, session) => removePane(acc, session, fallback), layout);
}

export function paneCount(layout: PaneLayout): number {
  return layout.groups.reduce((n, g) => n + g.panes.length, 0);
}

export function sessionsOf(layout: PaneLayout): string[] {
  return layout.groups.flatMap((g) => [...g.panes]);
}
