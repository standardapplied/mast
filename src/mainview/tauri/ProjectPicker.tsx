import { useEffect, useState } from "react";
import { cx } from "../components/cx";
import { CaretRight } from "../components/icons";
import { Button } from "../components/ui";
import { loadRoster, rowHint, rowMeta, type Roster, type RosterSources } from "./projectRoster";

/**
 * Pick which project container (or the node) to open a terminal into. The list
 * is the full synced catalog (`GET /v1/projects`) merged with the SSH routes
 * from `~/.ssh/config` — every project shows with its state; only ones with a
 * running container and a route are openable.
 */
export function ProjectPicker({
  sources,
  onPick,
  onCancel,
}: {
  sources: RosterSources;
  onPick: (target: string | undefined, label: string) => void;
  onCancel?: () => void;
}) {
  const [roster, setRoster] = useState<Roster | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadRoster(sources).then((loaded) => {
      if (!cancelled) setRoster(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [sources]);

  return (
    <div className="term-picker">
      <div className="term-picker__inner">
        <span className="eyebrow">Open a terminal</span>
        <h1 className="term-picker__title">Pick a project</h1>
        <p className="term-picker__hint">A shell into the container over the in-process SSH session.</p>

        <ul className="term-picker__list">
          {roster?.rows.map((row) => (
            <li key={row.name}>
              <button
                className={cx("term-picker__item", !row.connectable && "term-picker__item--disabled")}
                disabled={!row.connectable}
                title={rowHint(row)}
                onClick={() => onPick(row.name, row.name)}
              >
                <span className="term-picker__name">{row.name}</span>
                <span className="term-picker__meta">{rowMeta(row)}</span>
                {row.connectable && <CaretRight size={16} />}
              </button>
            </li>
          ))}
          <li>
            <button
              className="term-picker__item term-picker__item--muted"
              onClick={() => onPick(undefined, "node · devbox")}
            >
              <span className="term-picker__name">node · devbox</span>
              <span className="term-picker__meta">the control-plane host</span>
              <CaretRight size={16} />
            </button>
          </li>
        </ul>

        {!roster && <p className="term-picker__hint">Loading projects…</p>}
        {roster?.error && <p className="connect-error">Couldn’t load projects: {roster.error}</p>}
        {roster?.warning && <p className="term-picker__hint">{roster.warning}</p>}
        {roster && !roster.error && roster.rows.length === 0 && (
          <p className="term-picker__empty">
            No projects yet — create one with <code>sail create &lt;project&gt;</code>, or run{" "}
            <code>sail connect &lt;project&gt;</code> on your Mac to add an SSH route.
          </p>
        )}

        {onCancel && (
          <div className="term-picker__cancel">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
