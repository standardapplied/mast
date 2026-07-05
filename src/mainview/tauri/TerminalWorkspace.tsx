import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { CaretRight } from "../components/icons";
import { TerminalPane } from "./TerminalPane";
import { TerminalSplit } from "./TerminalSplit";

/**
 * The Terminal section: first pick which project container to open (project
 * name = ssh alias), then a live shell into it over the in-process russh
 * session. Targets come from `~/.ssh/config` today; the node will serve them
 * for the iOS-portable path (see spec `api-project-connect`).
 */

type Active = { target?: string; label: string };

export function TerminalWorkspace() {
  const [targets, setTargets] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Active | null>(null);

  useEffect(() => {
    invoke<string[]>("list_targets")
      .then(setTargets)
      .catch((e) => setError(String(e)));
  }, []);

  if (active) {
    // The node shell has no container filesystem; a project gets the split
    // (terminal + file tree + drag-drop), keyed so it resets per project.
    if (!active.target) {
      return <TerminalPane key={active.label} label={active.label} onBack={() => setActive(null)} />;
    }
    return (
      <TerminalSplit
        key={active.target}
        target={active.target}
        label={active.label}
        onBack={() => setActive(null)}
      />
    );
  }

  return (
    <div className="term-picker">
      <div className="term-picker__inner">
        <span className="eyebrow">Open a terminal</span>
        <h1 className="term-picker__title">Pick a project</h1>
        <p className="term-picker__hint">A shell into the container over the in-process SSH session.</p>

        <ul className="term-picker__list">
          {targets?.map((t) => (
            <li key={t}>
              <button className="term-picker__item" onClick={() => setActive({ target: t, label: t })}>
                <span className="term-picker__name">{t}</span>
                <span className="term-picker__meta">project container</span>
                <CaretRight size={16} />
              </button>
            </li>
          ))}
          <li>
            <button
              className="term-picker__item term-picker__item--muted"
              onClick={() => setActive({ label: "node · devbox" })}
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
      </div>
    </div>
  );
}
