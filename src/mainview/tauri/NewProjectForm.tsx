import { useState } from "react";
import type { ProjectDefinitionResponse } from "../../shared/sail-models";
import { cx } from "../components/cx";
import { Dialog } from "../components/Dialog";
import { Plus } from "../components/icons";
import { Button } from "../components/ui";
import type { CatalogStore } from "../board/catalogStore";
import { LabeledInput, RepoRows } from "../board/DefinitionFields";
import {
  NEW_PROJECT,
  newProjectDocument,
  RUNTIME_CHOICES,
  SERVICE_PRESETS,
  type NewProject,
} from "../board/definitionForms";
import { refusalDetail } from "../board/snapshots";

/**
 * Creates a project in the catalog, so every box on the team sees it: its name, resources,
 * runtimes, repos and services. Its container is made on the box that will run it; what sail
 * refuses comes back inline as sail's own sentence, and the form keeps every field as typed.
 */
export function NewProjectForm({
  catalog,
  onCreated,
  onClose,
}: {
  catalog: Pick<CatalogStore, "createProject">;
  onCreated: (created: ProjectDefinitionResponse) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<NewProject>(NEW_PROJECT);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const typed = JSON.stringify({ ...form, runtimes: [...form.runtimes] }) !==
    JSON.stringify({ ...NEW_PROJECT, runtimes: [] });
  const edit = (patch: Partial<NewProject>) => setForm((prev) => ({ ...prev, ...patch }));

  const toggleRuntime = (key: (typeof RUNTIME_CHOICES)[number]["key"]) => {
    const next = new Set(form.runtimes);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    edit({ runtimes: next });
  };
  const togglePreset = (name: string) => {
    const services = { ...form.services };
    if (services[name]) delete services[name];
    else services[name] = SERVICE_PRESETS.find((preset) => preset.name === name)!.service;
    edit({ services });
  };

  const create = async () => {
    const document = newProjectDocument(form);
    if (!document.ok) {
      setRefusal(document.message);
      return;
    }
    setCreating(true);
    setRefusal(null);
    const result = await catalog.createProject(document.value);
    setCreating(false);
    if (result.ok) onCreated(result.value);
    else setRefusal(refusalDetail(result.error));
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      onBeforeClose={() => {
        if (!typed || creating) return !creating;
        setLeaving(true);
        return false;
      }}
      title="New project"
      size="lg"
      footer={
        <div className="def-footer">
          <span className="def-footer__note">
            Git identity and SSH keys come from each box, never from the project.
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={creating || form.name.trim() === ""}
            onClick={() => void create()}
            data-testid="new-project-create"
          >
            {creating ? "Creating…" : "Create project"}
          </Button>
        </div>
      }
    >
      <div className="def-form" data-testid="new-project-form">
        <p className="def-about">
          Saved to the catalog, so every box on the team sees it. Processes, packages and the agent
          are set on the project once it exists.
        </p>
        {leaving && (
          <div className="def-banner" role="alert" data-testid="new-project-leaving">
            <span>Nothing is created yet, and closing drops what you typed.</span>
            <Button variant="ghost" onClick={() => setLeaving(false)}>
              Keep editing
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Discard and close
            </Button>
          </div>
        )}
        {refusal && (
          <p className="dispatch-block" role="alert" data-testid="new-project-refusal">
            {refusal}
          </p>
        )}
        <div className="def-grid def-grid--two">
          <LabeledInput id="new-project-name" label="Name" value={form.name} placeholder="acme-web" onChange={(name) => edit({ name })} />
          <LabeledInput
            id="new-project-description"
            label="Description"
            value={form.description}
            onChange={(description) => edit({ description })}
          />
        </div>
        <div className="def-grid def-grid--four">
          <LabeledInput id="new-project-image" label="Image" value={form.image} onChange={(image) => edit({ image })} />
          <LabeledInput id="new-project-cpu" label="CPU" value={form.cpu} inputMode="numeric" onChange={(cpu) => edit({ cpu })} />
          <LabeledInput id="new-project-memory" label="Memory" value={form.memory} onChange={(memory) => edit({ memory })} />
          <LabeledInput id="new-project-disk" label="Disk" value={form.disk} onChange={(disk) => edit({ disk })} />
        </div>
        <div className="def-group">
          <span className="def-group__label">Runtimes</span>
          <div className="def-chips">
            {RUNTIME_CHOICES.map((choice) => (
              <button
                key={choice.key}
                type="button"
                className={cx("def-chip", form.runtimes.has(choice.key) && "is-on")}
                aria-pressed={form.runtimes.has(choice.key)}
                onClick={() => toggleRuntime(choice.key)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
        <RepoRows rows={form.repos} onChange={(repos) => edit({ repos })} />
        <div className="def-group">
          <span className="def-group__label">Services</span>
          <div className="def-chips">
            {SERVICE_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className={cx("def-chip", form.services[preset.name] && "is-on")}
                aria-pressed={Boolean(form.services[preset.name])}
                onClick={() => togglePreset(preset.name)}
              >
                {preset.label}
              </button>
            ))}
            <span className="def-chips__hint">
              <Plus size={12} /> Any other image is added in the project's definition.
            </span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
