import type {
  DefinitionProcess,
  DefinitionRepo,
  DefinitionResources,
  DefinitionRuntimes,
  DefinitionSection,
  DefinitionService,
} from "../../shared/sail-models";
import { jsonText, portsFrom, readJson, repoPath } from "./definition";

/**
 * The form sections of a definition as their fields hold them: every field is text, so a value
 * half typed is kept as typed, and each form reads back as the section's value or as the field it
 * cannot be, named the way sail names it.
 */

export type Pair = { key: string; value: string };
export type ResourcesForm = { cpu: string; memory: string; disk: string };
export type RuntimesForm = { jdk: string; node: string; maven: string };
export type RepoForm = { url: string; path: string; branch: string };
export type ServiceForm = {
  name: string;
  image: string;
  ports: string;
  environment: Pair[];
  volumes: string[];
  command: string;
};
export type ProcessForm = { name: string; command: string; workdir: string; port: string; env: Pair[] };

export type FormRead<T> = { ok: true; value: T | null } | { ok: false; message: string };

const text = (value: string | number | undefined) => (value === undefined ? "" : String(value));
const pairs = (map: Record<string, string> | undefined): Pair[] =>
  Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
const mapOf = (rows: Pair[]): Record<string, string> | undefined => {
  const kept = rows.filter((row) => row.key.trim());
  return kept.length ? Object.fromEntries(kept.map((row) => [row.key.trim(), row.value])) : undefined;
};
const wholeNumber = (value: string) => /^\d+$/.test(value.trim());
const set = <T extends object>(value: T): T | null => {
  const kept = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
  return Object.keys(kept).length ? (kept as T) : null;
};
const refused = <T>(message: string): FormRead<T> => ({ ok: false, message });

export function resourcesForm(value: DefinitionResources | undefined): ResourcesForm {
  return { cpu: text(value?.cpu), memory: text(value?.memory), disk: text(value?.disk) };
}

export function readResources(form: ResourcesForm): FormRead<DefinitionResources> {
  if (form.cpu.trim() && !wholeNumber(form.cpu)) return refused("resources.cpu must be a whole number.");
  return {
    ok: true,
    value: set({
      cpu: form.cpu.trim() ? Number(form.cpu) : undefined,
      memory: form.memory.trim() || undefined,
      disk: form.disk.trim() || undefined,
    }),
  };
}

export function runtimesForm(value: DefinitionRuntimes | undefined): RuntimesForm {
  return { jdk: text(value?.jdk), node: text(value?.node), maven: text(value?.maven) };
}

export function readRuntimes(form: RuntimesForm): FormRead<DefinitionRuntimes> {
  if (form.jdk.trim() && !wholeNumber(form.jdk)) return refused("runtimes.jdk must be a whole number.");
  return {
    ok: true,
    value: set({
      jdk: form.jdk.trim() ? Number(form.jdk) : undefined,
      node: form.node.trim() || undefined,
      maven: form.maven.trim() || undefined,
    }),
  };
}

export function reposForm(value: DefinitionRepo[] | undefined): RepoForm[] {
  return (value ?? []).map((repo) => ({ url: repo.url, path: repo.path, branch: text(repo.branch) }));
}

export function readRepos(forms: RepoForm[], held: DefinitionRepo[] | undefined): FormRead<DefinitionRepo[]> {
  const kept = forms.filter((form) => form.url.trim() || form.path.trim() || form.branch.trim());
  const repos: DefinitionRepo[] = [];
  for (const form of kept) {
    if (!form.url.trim()) return refused("repos[].url is required.");
    const url = form.url.trim();
    const forge = held?.find((repo) => repo.url === url)?.forge;
    repos.push({
      url,
      path: form.path.trim() || repoPath(url),
      ...(form.branch.trim() ? { branch: form.branch.trim() } : {}),
      ...(forge ? { forge } : {}),
    });
  }
  return { ok: true, value: repos.length ? repos : null };
}

export function servicesForm(value: Record<string, DefinitionService> | undefined): ServiceForm[] {
  return Object.entries(value ?? {}).map(([name, service]) => ({
    name,
    image: service.image,
    ports: (service.ports ?? []).join(", "),
    environment: pairs(service.environment),
    volumes: service.volumes ?? [],
    command: text(service.command),
  }));
}

export function readServices(forms: ServiceForm[]): FormRead<Record<string, DefinitionService>> {
  const services: Record<string, DefinitionService> = {};
  for (const form of forms) {
    const name = form.name.trim();
    if (!name) return refused("services needs a name for every service.");
    if (services[name]) return refused(`services.${name} is named twice.`);
    if (!form.image.trim()) return refused(`services.${name}.image is required.`);
    const ports = portsFrom(form.ports);
    if (ports === null) return refused(`services.${name}.ports must be whole numbers, separated by commas.`);
    const volumes = form.volumes.map((volume) => volume.trim()).filter(Boolean);
    services[name] = {
      image: form.image.trim(),
      ...(ports.length ? { ports } : {}),
      ...(mapOf(form.environment) ? { environment: mapOf(form.environment) } : {}),
      ...(form.command.trim() ? { command: form.command.trim() } : {}),
      ...(volumes.length ? { volumes } : {}),
    };
  }
  return { ok: true, value: Object.keys(services).length ? services : null };
}

export function processesForm(value: Record<string, DefinitionProcess> | undefined): ProcessForm[] {
  return Object.entries(value ?? {}).map(([name, process]) => ({
    name,
    command: process.command,
    workdir: text(process.workdir),
    port: text(process.port),
    env: pairs(process.env),
  }));
}

export function readProcesses(forms: ProcessForm[]): FormRead<Record<string, DefinitionProcess>> {
  const processes: Record<string, DefinitionProcess> = {};
  for (const form of forms) {
    const name = form.name.trim();
    if (!name) return refused("processes needs a name for every process.");
    if (processes[name]) return refused(`processes.${name} is named twice.`);
    if (!form.command.trim()) return refused(`processes.${name}.command is required.`);
    if (form.port.trim() && !wholeNumber(form.port)) {
      return refused(`processes.${name}.port must be a whole number.`);
    }
    processes[name] = {
      command: form.command.trim(),
      ...(form.workdir.trim() ? { workdir: form.workdir.trim() } : {}),
      ...(form.port.trim() ? { port: Number(form.port) } : {}),
      ...(mapOf(form.env) ? { env: mapOf(form.env) } : {}),
    };
  }
  return { ok: true, value: Object.keys(processes).length ? processes : null };
}

export type SectionRead = { ok: true; value: unknown } | { ok: false; message: string; line: number | null };

/** What a section's editor holds for {@code value}: its form's fields, or its JSON text. */
export function modelOf(section: DefinitionSection, value: unknown): unknown {
  switch (section) {
    case "resources":
      return resourcesForm(value as DefinitionResources | undefined);
    case "runtimes":
      return runtimesForm(value as DefinitionRuntimes | undefined);
    case "repos":
      return reposForm(value as DefinitionRepo[] | undefined);
    case "services":
      return servicesForm(value as Record<string, DefinitionService> | undefined);
    case "processes":
      return processesForm(value as Record<string, DefinitionProcess> | undefined);
    default:
      return jsonText(value);
  }
}

/**
 * The value a section's editor holds, or why it holds none: a field it cannot be, or JSON that
 * is not, with the line it stops on. {@code held} is the section as the box holds it, whose
 * repo forges a form keeps.
 */
export function readModel(section: DefinitionSection, model: unknown, held: unknown): SectionRead {
  const form = (read: FormRead<unknown>): SectionRead =>
    read.ok ? read : { ok: false, message: read.message, line: null };
  switch (section) {
    case "resources":
      return form(readResources(model as ResourcesForm));
    case "runtimes":
      return form(readRuntimes(model as RuntimesForm));
    case "repos":
      return form(readRepos(model as RepoForm[], held as DefinitionRepo[] | undefined));
    case "services":
      return form(readServices(model as ServiceForm[]));
    case "processes":
      return form(readProcesses(model as ProcessForm[]));
    default: {
      const read = readJson(model as string);
      return read.ok ? read : { ok: false, message: `Line ${read.line}: ${read.message}`, line: read.line };
    }
  }
}
