/** Open terminal tabs (one per project, plus the node). Pure state helpers. */

export type Tab = { target?: string; label: string; key: string };

export function tabKey(target?: string): string {
  return target ?? "__node__";
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
