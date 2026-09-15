import { useSyncExternalStore } from "react";
import { cx } from "../components/cx";
import { attentionStore } from "../terminal/attention";
import { isUnwell, type SessionStatus } from "../terminal/connection";
import type { Tab } from "./terminalTabs";

/**
 * The project tabs of the terminal workspace. A tab carries its project's health (the warn dot)
 * and, when a pane in it rang a bell nobody has looked at, the same bell dot its chip shows — so a
 * build finishing in a project you are not looking at is visible from any other.
 */
export function TerminalTabStrip({
  tabs,
  activeKey,
  adding,
  statuses,
  panes,
  onActivate,
  onClose,
  onAdd,
}: {
  tabs: readonly Tab[];
  activeKey: string | null;
  adding: boolean;
  statuses: Readonly<Record<string, SessionStatus>>;
  /** Each tab's pane sessions, as its pane host reports them. */
  panes: Readonly<Record<string, readonly string[]>>;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onAdd: () => void;
}) {
  const unseenBells = useSyncExternalStore(attentionStore.subscribe, attentionStore.unseen);
  return (
    <div className="term-tabs__scroll" role="tablist">
      {tabs.map((t) => {
        const s = statuses[t.key];
        const unwell = s !== undefined && isUnwell(s);
        const belled = !unwell && (panes[t.key] ?? []).some((session) => unseenBells.has(session));
        const active = t.key === activeKey && !adding;
        return (
          <div
            key={t.key}
            role="tab"
            aria-selected={active}
            className={cx("term-tab", active && "is-active")}
            onClick={() => onActivate(t.key)}
          >
            {unwell && <span className="term-status__dot term-status__dot--warn" aria-hidden />}
            {belled && (
              <span className="term-status__dot term-status__dot--bell" data-testid="term-tab-bell-dot" aria-hidden />
            )}
            <span className="term-tab__label">{t.label}</span>
            <button
              type="button"
              className="term-tab__close"
              aria-label={`Close ${t.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.key);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={cx("term-tab__add", adding && "is-active")}
        aria-label="Open another project"
        onClick={onAdd}
      >
        ＋
      </button>
    </div>
  );
}
