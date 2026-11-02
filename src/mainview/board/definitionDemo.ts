import type {
  DefinitionSection,
  ProjectDefinitionDocument,
  ProjectDefinitionResponse,
} from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { SECTIONS } from "./definition";

/**
 * The demo box's project catalog: definitions held in memory, each section tagged by its own
 * JSON, so the demo refuses a write over a section that moved and a name already taken exactly
 * as a box does.
 */
export type DemoDefinitions = {
  names(): string[];
  get(project: string): SailResult<ProjectDefinitionResponse>;
  create(definition: ProjectDefinitionDocument): SailResult<ProjectDefinitionResponse>;
  write(
    project: string,
    section: DefinitionSection,
    value: unknown,
    tag: string,
  ): SailResult<ProjectDefinitionResponse>;
  /** Writes a section as someone else would, moving its tag under an open editor. */
  touch(project: string, section: DefinitionSection, value: unknown): void;
};

const tagOf = (value: unknown) => JSON.stringify(value ?? null);

export function createDemoDefinitions(seed: ProjectDefinitionDocument[]): DemoDefinitions {
  const held = new Map<string, { document: ProjectDefinitionDocument; by: string; at: string }>();
  for (const document of seed) held.set(document.name, { document, by: "uday", at: "2026-10-30T09:00:00Z" });

  const response = (project: string): ProjectDefinitionResponse => {
    const row = held.get(project)!;
    const tags = Object.fromEntries(
      SECTIONS.map((section) => [section, tagOf(row.document[section])]),
    ) as Record<DefinitionSection, string>;
    return { name: project, definition: row.document, tags, updated_by: row.by, updated_at: row.at };
  };
  const notFound = <T>(project: string): SailResult<T> => ({
    ok: false,
    error: { status: 404, code: "project_not_found", message: `Project '${project}' was not found.` },
  });
  const put = (project: string, section: DefinitionSection, value: unknown, by: string) => {
    const row = held.get(project)!;
    const document = { ...row.document };
    if (value === null) delete document[section];
    else (document as Record<string, unknown>)[section] = value;
    held.set(project, { document, by, at: new Date().toISOString() });
  };

  return {
    names: () => [...held.keys()],
    get: (project) => (held.has(project) ? { ok: true, value: response(project) } : notFound(project)),
    create(definition) {
      if (held.has(definition.name)) {
        return {
          ok: false,
          error: {
            status: 409,
            code: "conflict",
            message: `A project named '${definition.name}' already exists.`,
            action: "Choose another name, or edit that project's definition.",
          },
        };
      }
      const ssh = definition.repos?.find((repo) => !repo.url.startsWith("https://"));
      if (ssh) {
        return {
          ok: false,
          error: {
            status: 422,
            code: "invalid_request",
            message: `repos[].url '${ssh.url}' is not an https URL: sail clones over https with the box's forge token. Use the repository's https URL.`,
          },
        };
      }
      held.set(definition.name, { document: definition, by: "uday", at: new Date().toISOString() });
      return { ok: true, value: response(definition.name) };
    },
    write(project, section, value, tag) {
      if (!held.has(project)) return notFound(project);
      if (tagOf(held.get(project)!.document[section]) !== tag) {
        return {
          ok: false,
          error: {
            status: 412,
            code: "precondition_failed",
            message: `The ${section} section of '${project}' changed since you read it.`,
            action: "Read the definition again, then write the section.",
          },
        };
      }
      put(project, section, value, "uday");
      return { ok: true, value: response(project) };
    },
    touch: (project, section, value) => put(project, section, value, "ravi"),
  };
}
