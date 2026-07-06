import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { CaretRight } from "../components/icons";
import { Button } from "../components/ui";

/**
 * Pick which project container (or the node) to open a terminal into. Targets
 * are the `~/.ssh/config` aliases that have a ProxyJump (`list_targets`).
 */
export function ProjectPicker({
  onPick,
  onCancel,
}: {
  onPick: (target: string | undefined, label: string) => void;
  onCancel?: () => void;
}) {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string[]>("list_targets")
      .then(setTargets)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="term-picker">
      <div className="term-picker__inner">
        <span className="eyebrow">Open a terminal</span>
        <h1 className="term-picker__title">Pick a project</h1>
        <p className="term-picker__hint">A shell into the container over the in-process SSH session.</p>

        <ul className="term-picker__list">
          {targets?.map((t) => (
            <li key={t}>
              <button className="term-picker__item" onClick={() => onPick(t, t)}>
                <span className="term-picker__name">{t}</span>
                <span className="term-picker__meta">project container</span>
                <CaretRight size={16} />
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

        {!targets && !error && <p className="term-picker__hint">Reading ~/.ssh/config…</p>}
        {targets && targets.length === 0 && (
          <p className="term-picker__empty">
            No project containers in <code>~/.ssh/config</code> yet — run{" "}
            <code>sail connect &lt;project&gt;</code> on your Mac to add one.
          </p>
        )}
        {error && <p className="connect-error">Couldn’t read targets: {error}</p>}

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
