import { useEffect, useState } from "react";
import type { DefinitionSection, ProjectDefinitionResponse } from "../../shared/sail-models";
import { cx } from "../components/cx";
import { Dialog } from "../components/Dialog";
import { LoadingMark } from "../components/Loading";
import { Button } from "../components/ui";
import type { CatalogStore } from "./catalogStore";
import { jsonText, PANEL_SECTIONS, refusedLine } from "./definition";
import {
  JsonEditor,
  LabeledInput,
  PairRows,
  replaced,
  RepoRows,
  TextRows,
  without,
} from "./DefinitionFields";
import {
  modelOf,
  readModel,
  type ProcessForm,
  type RepoForm,
  type ResourcesForm,
  type RuntimesForm,
  type ServiceForm,
} from "./definitionForms";
import { relativeTime } from "./rooms";
import { refusalDetail } from "./snapshots";

/**
 * A project's definition, one section at a time: a form where one fits, the section's JSON
 * where it does not. Each section saves on its own over the version it was read at; a section
 * someone changed meanwhile is refused, never overwritten, and the edit stays: the panel offers
 * their version to look at and saving this one over it. A refusal is sail's own sentence, on the
 * line of the JSON it names.
 */

type Draft = { model: unknown; tag: string };
type Refusal = { message: string; line: number | null };
/** A section refused for having moved: the version it moved to, shown and saved over as is. */
type Conflict = { theirs: { value: unknown; tag: string }; showing: boolean };
type BySection<T> = Partial<Record<DefinitionSection, T>>;

const omit = <T,>(map: BySection<T>, key: DefinitionSection): BySection<T> => {
  const { [key]: _gone, ...rest } = map;
  return rest as BySection<T>;
};
const sameModel = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function DefinitionPanel({
  catalog,
  project,
  now = Date.now,
  onClose,
}: {
  catalog: Pick<CatalogStore, "readDefinition" | "writeSection">;
  project: string;
  now?: () => number;
  onClose: () => void;
}) {
  const [held, setHeld] = useState<ProjectDefinitionResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<DefinitionSection>("resources");
  const [drafts, setDrafts] = useState<BySection<Draft>>({});
  const [refusals, setRefusals] = useState<BySection<Refusal>>({});
  const [conflicts, setConflicts] = useState<BySection<Conflict>>({});
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let live = true;
    void catalog.readDefinition(project).then((result) => {
      if (!live) return;
      if (result.ok) setHeld(result.value);
      else setLoadError(refusalDetail(result.error));
    });
    return () => {
      live = false;
    };
  }, [catalog, project]);

  const section = PANEL_SECTIONS.find((s) => s.key === active)!;
  const heldValue = (key: DefinitionSection) => held?.definition[key];
  const draftOf = (key: DefinitionSection): Draft =>
    drafts[key] ?? { model: modelOf(key, heldValue(key)), tag: held!.tags[key] };
  const dirty = (key: DefinitionSection) =>
    drafts[key] !== undefined && !sameModel(drafts[key]!.model, modelOf(key, heldValue(key)));
  const unsaved = PANEL_SECTIONS.filter((s) => dirty(s.key));

  const edit = (model: unknown) =>
    setDrafts((prev) => ({ ...prev, [active]: { model, tag: prev[active]?.tag ?? held!.tags[active] } }));
  const refuse = (key: DefinitionSection, refusal: Refusal) =>
    setRefusals((prev) => ({ ...prev, [key]: refusal }));

  /**
   * Writes {@code key}'s draft over {@code over}, or over the tag the draft was read at. An edit
   * typed while the write was in flight stays, now over the version the write made.
   */
  const save = async (key: DefinitionSection, over?: string) => {
    const draft = draftOf(key);
    const read = readModel(key, draft.model);
    if (!read.ok) {
      refuse(key, { message: read.message, line: read.line });
      return;
    }
    setSaving(true);
    setRefusals((prev) => omit(prev, key));
    const result = await catalog.writeSection(project, key, read.value, over ?? draft.tag);
    if (result.ok) {
      setSaving(false);
      setHeld(result.value);
      setDrafts((prev) =>
        prev[key] && !sameModel(prev[key]!.model, draft.model)
          ? { ...prev, [key]: { model: prev[key]!.model, tag: result.value.tags[key] } }
          : omit(prev, key),
      );
      setConflicts((prev) => omit(prev, key));
      return;
    }
    if (result.error.code === "precondition_failed") {
      const theirs = await catalog.readDefinition(project);
      setSaving(false);
      if (theirs.ok) {
        setHeld(theirs.value);
        setConflicts((prev) => ({
          ...prev,
          [key]: {
            theirs: { value: theirs.value.definition[key], tag: theirs.value.tags[key] },
            showing: false,
          },
        }));
      } else {
        refuse(key, { message: refusalDetail(theirs.error), line: null });
      }
      return;
    }
    setSaving(false);
    const json = PANEL_SECTIONS.find((s) => s.key === key)!.editor === "json";
    refuse(key, {
      message: refusalDetail(result.error),
      line: json ? refusedLine(draft.model as string, key, result.error.message) : null,
    });
  };

  const discard = () => {
    setDrafts((prev) => omit(prev, active));
    setRefusals((prev) => omit(prev, active));
    setConflicts((prev) => omit(prev, active));
  };

  const shownRefusal = refusals[active];
  const shownConflict = conflicts[active];

  const footer = held && (
    <div className="def-footer">
      <span className="def-footer__note">
        {dirty(active) ? `Unsaved changes in ${section.label}` : "Saved"}
      </span>
      <Button variant="ghost" disabled={!dirty(active) || saving} onClick={discard}>
        Discard
      </Button>
      <Button
        disabled={!dirty(active) || saving}
        onClick={() => void save(active)}
        data-testid="def-save"
      >
        {saving ? "Saving…" : `Save ${section.label.toLowerCase()}`}
      </Button>
    </div>
  );

  return (
    <Dialog
      isOpen
      size="xl"
      title={`Definition — ${project}`}
      footer={footer || undefined}
      onClose={onClose}
      onBeforeClose={() => {
        if (unsaved.length === 0) return true;
        setLeaving(true);
        return false;
      }}
    >
      <div className="def-panel" data-testid="definition-panel">
        {loadError && (
          <p className="dispatch-block" role="alert">
            {loadError}
          </p>
        )}
        {!held && !loadError && <LoadingMark label={`Reading ${project}'s definition`} />}
        {held && (
          <>
            <p className="def-panel__changed">
              Last changed{held.updated_by ? ` by ${held.updated_by}` : ""} ·{" "}
              {relativeTime(held.updated_at, now())}
            </p>
            {leaving && unsaved.length > 0 && (
              <div className="def-banner" role="alert" data-testid="def-leaving">
                <span>
                  Unsaved changes in {unsaved.map((s) => s.label).join(", ")}. Nothing of them is
                  saved yet.
                </span>
                <Button variant="ghost" onClick={() => setLeaving(false)}>
                  Keep editing
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Discard and close
                </Button>
              </div>
            )}
            <div className="def-panel__body">
              <nav className="def-nav" aria-label="Sections">
                {PANEL_SECTIONS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={cx("def-nav__item", s.key === active && "is-active")}
                    aria-current={s.key === active ? "page" : undefined}
                    onClick={() => setActive(s.key)}
                  >
                    {s.label}
                    {dirty(s.key) && (
                      <span className="def-nav__dot">
                        <span className="sr-only">, unsaved</span>
                      </span>
                    )}
                  </button>
                ))}
              </nav>
              <section className="def-section" aria-label={section.label}>
                <p className="def-about">
                  {section.about} Applied to a box the next time it runs{" "}
                  <code>sail project apply {project}</code>.
                </p>
                {shownConflict && (
                  <div className="def-banner def-banner--conflict" role="alert" data-testid="def-conflict">
                    <span>
                      {section.label} changed since you opened it. Your edit is still here and
                      nothing was saved.
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setConflicts((prev) => ({
                          ...prev,
                          [active]: { ...shownConflict, showing: !shownConflict.showing },
                        }))
                      }
                    >
                      {shownConflict.showing ? "Back to my edit" : "Show theirs"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => void save(active, shownConflict.theirs.tag)}
                    >
                      Save mine over it
                    </Button>
                  </div>
                )}
                {shownConflict?.showing ? (
                  <JsonEditor
                    label={`Theirs · ${section.label}`}
                    text={jsonText(shownConflict.theirs.value)}
                    readOnly
                  />
                ) : (
                  <SectionEditor
                    section={active}
                    model={draftOf(active).model}
                    errorLine={shownRefusal?.line ?? null}
                    errorId={shownRefusal ? "def-refusal" : undefined}
                    onChange={edit}
                  />
                )}
                {shownRefusal && (
                  <p id="def-refusal" className="def-error" role="alert" data-testid="def-refusal">
                    {shownRefusal.message}
                  </p>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function SectionEditor({
  section,
  model,
  errorLine,
  errorId,
  onChange,
}: {
  section: DefinitionSection;
  model: unknown;
  errorLine: number | null;
  errorId?: string;
  onChange: (model: unknown) => void;
}) {
  switch (section) {
    case "resources": {
      const form = model as ResourcesForm;
      return (
        <div className="def-grid def-grid--three">
          <LabeledInput id="def-cpu" label="CPU" value={form.cpu} inputMode="numeric" onChange={(cpu) => onChange({ ...form, cpu })} />
          <LabeledInput id="def-memory" label="Memory" value={form.memory} placeholder="8GB" onChange={(memory) => onChange({ ...form, memory })} />
          <LabeledInput id="def-disk" label="Disk" value={form.disk} placeholder="50GB" onChange={(disk) => onChange({ ...form, disk })} />
        </div>
      );
    }
    case "runtimes": {
      const form = model as RuntimesForm;
      return (
        <div className="def-grid def-grid--three">
          <LabeledInput id="def-jdk" label="JDK" value={form.jdk} inputMode="numeric" placeholder="26" onChange={(jdk) => onChange({ ...form, jdk })} />
          <LabeledInput id="def-node" label="Node" value={form.node} placeholder="24" onChange={(node) => onChange({ ...form, node })} />
          <LabeledInput id="def-maven" label="Maven" value={form.maven} placeholder="3.9.14" onChange={(maven) => onChange({ ...form, maven })} />
        </div>
      );
    }
    case "repos":
      return <RepoRows rows={model as RepoForm[]} onChange={onChange} />;
    case "services":
      return <ServiceCards rows={model as ServiceForm[]} onChange={onChange} />;
    case "processes":
      return <ProcessCards rows={model as ProcessForm[]} onChange={onChange} />;
    default:
      return (
        <JsonEditor
          label={PANEL_SECTIONS.find((s) => s.key === section)!.label}
          text={model as string}
          errorLine={errorLine}
          errorId={errorId}
          onChange={onChange}
        />
      );
  }
}

function ServiceCards({ rows, onChange }: { rows: ServiceForm[]; onChange: (rows: ServiceForm[]) => void }) {
  const put = (index: number, row: ServiceForm) => onChange(replaced(rows, index, row));
  return (
    <div className="def-cards">
      {rows.map((row, index) => (
        <div className="def-card" key={index} data-testid={`def-service-${index}`}>
          <div className="def-card__head">
            <LabeledInput id={`def-service-${index}-name`} label="Name" value={row.name} onChange={(name) => put(index, { ...row, name })} />
            <Button variant="ghost" onClick={() => onChange(without(rows, index))}>
              Remove
            </Button>
          </div>
          <div className="def-grid def-grid--two">
            <LabeledInput id={`def-service-${index}-image`} label="Image" value={row.image} placeholder="postgres:16" onChange={(image) => put(index, { ...row, image })} />
            <LabeledInput id={`def-service-${index}-ports`} label="Ports" value={row.ports} placeholder="5432" onChange={(ports) => put(index, { ...row, ports })} />
          </div>
          <LabeledInput id={`def-service-${index}-command`} label="Command" value={row.command} onChange={(command) => put(index, { ...row, command })} />
          <PairRows
            label="Environment"
            rows={row.environment}
            keyHint="NAME"
            valueHint="value"
            addLabel="Variable"
            onChange={(environment) => put(index, { ...row, environment })}
          />
          <TextRows
            label="Volumes"
            rows={row.volumes}
            hint="data:/var/lib/data"
            addLabel="Volume"
            onChange={(volumes) => put(index, { ...row, volumes })}
          />
        </div>
      ))}
      <Button
        variant="ghost"
        className="def-add"
        onClick={() => onChange([...rows, { name: "", image: "", ports: "", environment: [], volumes: [], command: "" }])}
      >
        + Service
      </Button>
    </div>
  );
}

function ProcessCards({ rows, onChange }: { rows: ProcessForm[]; onChange: (rows: ProcessForm[]) => void }) {
  const put = (index: number, row: ProcessForm) => onChange(replaced(rows, index, row));
  return (
    <div className="def-cards">
      {rows.map((row, index) => (
        <div className="def-card" key={index} data-testid={`def-process-${index}`}>
          <div className="def-card__head">
            <LabeledInput id={`def-process-${index}-name`} label="Name" value={row.name} onChange={(name) => put(index, { ...row, name })} />
            <Button variant="ghost" onClick={() => onChange(without(rows, index))}>
              Remove
            </Button>
          </div>
          <LabeledInput id={`def-process-${index}-command`} label="Command" value={row.command} placeholder="npm run dev" onChange={(command) => put(index, { ...row, command })} />
          <div className="def-grid def-grid--two">
            <LabeledInput id={`def-process-${index}-workdir`} label="Workdir" value={row.workdir} placeholder="web" onChange={(workdir) => put(index, { ...row, workdir })} />
            <LabeledInput id={`def-process-${index}-port`} label="Port" value={row.port} inputMode="numeric" placeholder="3000" onChange={(port) => put(index, { ...row, port })} />
          </div>
          <PairRows
            label="Environment"
            rows={row.env}
            keyHint="NAME"
            valueHint="value"
            addLabel="Variable"
            onChange={(env) => put(index, { ...row, env })}
          />
        </div>
      ))}
      <Button
        variant="ghost"
        className="def-add"
        onClick={() => onChange([...rows, { name: "", command: "", workdir: "", port: "", env: [] }])}
      >
        + Process
      </Button>
    </div>
  );
}
