import { useEffect, useState } from "react";
import { cx } from "../components/cx";
import { CaretRight, Plus } from "../components/icons";
import { Button } from "../components/ui";
import type { CatalogStore } from "../board/catalogStore";
import { NewProjectForm } from "./NewProjectForm";
import { applyCommand, loadRoster, rowHint, rowMeta, type Roster, type RosterSources } from "./projectRoster";

/**
 * Pick which project container (or the node) to open a terminal into. The list
 * is the full synced catalog (`GET /v1/projects`) merged with the routes the
 * core can open (see `projectRoster`) — every project shows with its state; only
 * ones with a running container and a route are openable. A project the catalog
 * holds with no container here says the command that makes one, and a new
 * project is created in the catalog from here.
 */
export function ProjectPicker({
  sources,
  catalog,
  copyText,
  onEditDefinition,
  onPick,
  onCancel,
}: {
  sources: RosterSources;
  catalog?: Pick<CatalogStore, "createProject">;
  copyText?: (text: string) => Promise<void>;
  onEditDefinition?: (project: string) => void;
  onPick: (target: string | undefined, label: string) => void;
  onCancel?: () => void;
}) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ project: string; failed: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadRoster(sources).then((loaded) => {
      if (!cancelled) setRoster(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [sources, reloads]);

  const copy = (project: string) => {
    copyText?.(applyCommand(project)).then(
      () => setCopied({ project, failed: false }),
      () => setCopied({ project, failed: true }),
    );
  };

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
              {row.status === "not_created" && (
                <div className="term-picker__apply" data-testid={`picker-apply-${row.name}`}>
                  {created === row.name && (
                    <p className="term-picker__created">
                      Created in the catalog. Its container is made on the box that will run it:
                    </p>
                  )}
                  <div className="term-picker__command">
                    <code>{applyCommand(row.name)}</code>
                    {copyText && (
                      <Button variant="ghost" onClick={() => copy(row.name)}>
                        {copied?.project !== row.name ? "Copy" : copied.failed ? "Copy failed" : "Copied"}
                      </Button>
                    )}
                    {onEditDefinition && (
                      <Button variant="ghost" onClick={() => onEditDefinition(row.name)}>
                        Edit definition
                      </Button>
                    )}
                  </div>
                </div>
              )}
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
          {catalog && (
            <li>
              <button
                className="term-picker__item term-picker__item--new"
                onClick={() => setCreating(true)}
                data-testid="picker-new-project"
              >
                <Plus size={16} />
                <span className="term-picker__name">New project</span>
              </button>
            </li>
          )}
        </ul>

        {!roster && <p className="term-picker__hint">Loading projects…</p>}
        {roster?.error && <p className="connect-error">Couldn’t load projects: {roster.error}</p>}
        {roster?.warning && <p className="term-picker__hint">{roster.warning}</p>}
        {roster && !roster.error && roster.rows.length === 0 && (
          <p className="term-picker__empty">
            No projects yet. Create one with New project, or with{" "}
            <code>sail project create &lt;name&gt;</code> on the box.
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
      {catalog && creating && (
        <NewProjectForm
          catalog={catalog}
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            setCreated(project.name);
            setReloads((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
