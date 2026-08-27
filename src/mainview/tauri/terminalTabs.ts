/** Open terminal tabs (one per project, plus the node). Pure state helpers. */

export type Tab = { target?: string; label: string; key: string };

export function tabKey(target?: string): string {
  return target ?? "__node__";
}

/** The host session to attach for a tab: the node shell, or a per-project container session. */
export type SessionSpec = { session: string; project: string };

/**
 * Maps a tab's target to its durable host session. A project tab attaches a `mast-<project>` session
 * whose `project` tells the node pty-host to run it inside that container (`incus exec`); the node
 * tab (no target) runs a plain shell on the box itself.
 */
export function sessionSpecFor(target?: string): SessionSpec {
  return target
    ? { session: `mast-${target}`, project: target }
    : { session: "mast-node", project: "" };
}

/** Add a tab, or no-op if the project is already open. */
export function addTab(tabs: Tab[], target: string | undefined, label: string): Tab[] {
  const key = tabKey(target);
  return tabs.some((t) => t.key === key) ? tabs : [...tabs, { target, label, key }];
}

/** Which tab to focus after closing `closingKey` — the last remaining, or none. */
export function nextActive(tabs: Tab[], closingKey: string, activeKey: string | null): string | null {
  if (activeKey !== closingKey) return activeKey;
  const remaining = tabs.filter((t) => t.key !== closingKey);
  return remaining.length ? remaining[remaining.length - 1]!.key : null;
}
