import { useState } from "react";
import { SnapshotsPanel } from "../board/SnapshotsPanel";
import { cx } from "../components/cx";
import type { Gateway } from "../gateway";
import { ProjectPicker } from "./ProjectPicker";
import type { RosterSources } from "./projectRoster";
import { addTab, nextActive, tabKey, type Tab } from "./terminalTabs";
import { TerminalPane } from "./TerminalPane";
import { TerminalSplit } from "./TerminalSplit";

/**
 * The Terminal section: browser-tab UX over project workspaces. Each open
 * project keeps its own terminal + file tree mounted (hidden when inactive), so
 * switching is instant and never tears down / garbles a live session. "+" opens
 * the picker for another project.
 */
export function TerminalWorkspace({
  sources,
  gateway,
}: {
  sources: RosterSources;
  gateway?: Gateway;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [snapshotsFor, setSnapshotsFor] = useState<string | null>(null);

  const open = (target: string | undefined, label: string) => {
    setTabs((prev) => addTab(prev, target, label));
    setActiveKey(tabKey(target));
    setAdding(false);
  };
  const close = (key: string) => {
    setActiveKey((a) => nextActive(tabs, key, a));
    setTabs((prev) => prev.filter((t) => t.key !== key));
  };

  const showPicker = tabs.length === 0 || adding;
  const activeTarget = tabs.find((t) => t.key === activeKey)?.target;

  return (
    <div className="term-workspace">
      {tabs.length > 0 && (
        <div className="term-tabs">
          {tabs.map((t) => (
            <div
              key={t.key}
              className={cx("term-tab", t.key === activeKey && !adding && "is-active")}
              onClick={() => {
                setActiveKey(t.key);
                setAdding(false);
              }}
            >
              <span className="term-tab__label">{t.label}</span>
              <button
                type="button"
                className="term-tab__close"
                aria-label={`Close ${t.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  close(t.key);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className={cx("term-tab__add", adding && "is-active")}
            aria-label="Open another project"
            onClick={() => setAdding(true)}
          >
            ＋
          </button>
          {gateway && activeTarget && !adding && (
            <button
              type="button"
              className="dep-chip term-tab__tools"
              onClick={() => setSnapshotsFor(activeTarget)}
            >
              Snapshots
            </button>
          )}
        </div>
      )}

      <div className="term-workspace__body">
        {tabs.map((t) => {
          const active = t.key === activeKey && !showPicker;
          return (
            <div
              key={t.key}
              className="term-workspace__view"
              style={{ display: active ? "flex" : "none" }}
            >
              {t.target ? (
                <TerminalSplit target={t.target} label={t.label} active={active} />
              ) : (
                <TerminalPane label={t.label} active={active} />
              )}
            </div>
          );
        })}
        {showPicker && (
          <ProjectPicker
            sources={sources}
            onPick={open}
            onCancel={tabs.length > 0 ? () => setAdding(false) : undefined}
          />
        )}
      </div>
      {gateway && snapshotsFor && (
        <SnapshotsPanel
          gateway={gateway}
          project={snapshotsFor}
          onClose={() => setSnapshotsFor(null)}
        />
      )}
    </div>
  );
}
