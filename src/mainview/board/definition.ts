import type {
  DefinitionRepo,
  DefinitionSection,
  DefinitionService,
  ProjectDefinitionDocument,
} from "../../shared/sail-models";

/**
 * A project's definition as Mast edits it: which sections the Definition panel shows and how,
 * the JSON a section's editor holds, where in that JSON a refusal points, and the document the
 * New project form creates. Transport-free, so the panel and the form stay thin.
 */

/** Every section of a definition, in the order sail writes them. */
export const SECTIONS: readonly DefinitionSection[] = [
  "description",
  "image",
  "resources",
  "runtimes",
  "repos",
  "services",
  "processes",
  "packages",
  "agent",
  "pipeline",
];

export type PanelSection = {
  key: DefinitionSection;
  label: string;
  editor: "form" | "json";
  about: string;
};

/** The sections the Definition panel edits: a form where one fits, the section's JSON otherwise. */
export const PANEL_SECTIONS: readonly PanelSection[] = [
  { key: "resources", label: "Resources", editor: "form", about: "The CPU, memory and disk the container is given." },
  { key: "runtimes", label: "Runtimes", editor: "form", about: "The language runtimes installed in the container." },
  {
    key: "repos",
    label: "Repos",
    editor: "form",
    about: "Repositories cloned into ~/workspace, over https with each box's forge token.",
  },
  {
    key: "services",
    label: "Services",
    editor: "form",
    about: "Containers that run beside the project's code, reachable from it by name.",
  },
  {
    key: "processes",
    label: "Processes",
    editor: "form",
    about: "The commands that start the project's apps, each with the port it listens on.",
  },
  { key: "packages", label: "Packages", editor: "json", about: "System packages installed with apt, as a list." },
  {
    key: "agent",
    label: "Agent",
    editor: "json",
    about: "The agent that builds, the agents each box installs, and the limits a build runs under.",
  },
  {
    key: "pipeline",
    label: "Review pipeline",
    editor: "json",
    about: "The review stages that follow a build, their briefs and the limits they run under.",
  },
];

/** A section's value as its JSON editor shows it; an unset section is empty. */
export function jsonText(value: unknown): string {
  return value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
}

export type JsonRead = { ok: true; value: unknown } | { ok: false; line: number; message: string };

/** The value a JSON editor's text holds; empty text unsets the section. */
export function readJson(text: string): JsonRead {
  if (text.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, line: syntaxLine(text), message: "This is not JSON." };
  }
}

/**
 * The line of the first character that stops {@code text} being one JSON value: the webview's
 * own parser names no position, so a small scanner finds it.
 */
export function syntaxLine(text: string): number {
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at++;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, at)) at += word.length;
    else throw at;
  };
  const string = () => {
    at++;
    while (at < text.length && text[at] !== '"') {
      if (text[at] === "\n") throw at;
      at += text[at] === "\\" ? 2 : 1;
    }
    if (at >= text.length) throw at;
    at++;
  };
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at));
    if (!match) throw at;
    at += match[0].length;
  };
  const items = (close: string, item: () => void) => {
    at++;
    space();
    if (text[at] === close) {
      at++;
      return;
    }
    for (;;) {
      item();
      space();
      if (text[at] === ",") {
        at++;
        continue;
      }
      if (text[at] === close) {
        at++;
        return;
      }
      throw at;
    }
  };
  const value = (): void => {
    space();
    const next = text[at];
    if (next === "{") {
      items("}", () => {
        space();
        if (text[at] !== '"') throw at;
        string();
        space();
        if (text[at] !== ":") throw at;
        at++;
        value();
      });
    } else if (next === "[") items("]", value);
    else if (next === '"') string();
    else if (next === "t") literal("true");
    else if (next === "f") literal("false");
    else if (next === "n") literal("null");
    else number();
  };
  try {
    value();
    space();
    if (at < text.length) throw at;
    return 0;
  } catch (failedAt) {
    return lineOf(text, Math.min(failedAt as number, text.length));
  }
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * The line of {@code text}, the JSON of {@code section}, that the field a refusal names sits on:
 * sail starts each refusal with the field's path (`agent.guardrails.max_duration ...`), and the
 * line is the first that keys its last part. Null when the refusal names no field it holds.
 */
export function refusedLine(text: string, section: DefinitionSection, refusal: string): number | null {
  const path = /^([a-z_]+(?:\[\d*\])?(?:\.[a-z_]+(?:\[\d*\])?)*)\b/.exec(refusal)?.[1];
  if (!path) return null;
  const parts = path.split(".").map((part) => part.replace(/\[\d*\]$/, ""));
  if (parts[0] === section) parts.shift();
  const key = parts.at(-1);
  if (!key) return null;
  const keyed = new RegExp(`"${key}"\\s*:`);
  const index = text.split("\n").findIndex((line) => keyed.test(line));
  return index < 0 ? null : index + 1;
}

/** Whether a section's draft differs from what the box holds. */
export function changed(draft: unknown, held: unknown): boolean {
  return JSON.stringify(draft ?? null) !== JSON.stringify(held ?? null);
}

/** The service presets the New project form offers, as `sail project create --service` gives them. */
export const SERVICE_PRESETS: readonly { name: string; label: string; service: DefinitionService }[] = [
  {
    name: "postgres",
    label: "postgres:16 · 5432",
    service: {
      image: "postgres:16",
      ports: [5432],
      environment: { POSTGRES_DB: "app", POSTGRES_USER: "dev", POSTGRES_PASSWORD: "dev" },
      volumes: ["pgdata:/var/lib/postgresql/data"],
    },
  },
  { name: "redis", label: "redis:7 · 6379", service: { image: "redis:7", ports: [6379] } },
];

/** The runtimes the New project form offers, each a toggle. */
export const RUNTIME_CHOICES = [
  { key: "jdk", label: "JDK 26", value: 26 },
  { key: "node", label: "Node 24", value: "24" },
  { key: "maven", label: "Maven 3.9.14", value: "3.9.14" },
] as const;

export type NewProject = {
  name: string;
  description: string;
  image: string;
  cpu: string;
  memory: string;
  disk: string;
  runtimes: ReadonlySet<(typeof RUNTIME_CHOICES)[number]["key"]>;
  repos: DefinitionRepo[];
  services: Record<string, DefinitionService>;
};

export const NEW_PROJECT: NewProject = {
  name: "",
  description: "",
  image: "ubuntu/24.04",
  cpu: "2",
  memory: "8GB",
  disk: "50GB",
  runtimes: new Set(),
  repos: [],
  services: {},
};

/**
 * The definition the New project form creates: what `sail project create` writes for the same
 * answers, its agent the default one. Sail checks it whole; a value it refuses comes back as
 * its own sentence.
 */
export function newProjectDocument(form: NewProject): ProjectDefinitionDocument {
  const document: ProjectDefinitionDocument = {
    name: form.name.trim(),
    image: form.image,
    resources: { cpu: Number(form.cpu), memory: form.memory.trim(), disk: form.disk.trim() },
    agent: { type: "claude-code", auto_branch: true, branch_prefix: "agent/", auto_snapshot: true },
  };
  if (form.description.trim()) document.description = form.description.trim();
  if (form.runtimes.size > 0) {
    document.runtimes = Object.fromEntries(
      RUNTIME_CHOICES.filter((choice) => form.runtimes.has(choice.key)).map((choice) => [
        choice.key,
        choice.value,
      ]),
    );
  }
  if (form.repos.length > 0) document.repos = form.repos;
  if (Object.keys(form.services).length > 0) document.services = form.services;
  return document;
}

/** A repo's path when none is typed: the last part of its URL, without `.git`. */
export function repoPath(url: string): string {
  return url.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/, "") ?? "";
}

/** A comma-separated list of ports, or null when one is not a whole number. */
export function portsFrom(text: string): number[] | null {
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.every((part) => /^\d+$/.test(part)) ? parts.map(Number) : null;
}
