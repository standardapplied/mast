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
    return { ok: false, line: syntaxLine(text) || text.split("\n").length, message: "This is not JSON." };
  }
}

type Scan = { error: number | null; lines: Map<string, number> };

/**
 * Walks {@code text} as JSON, as strictly as `JSON.parse` reads it: where it first stops being one
 * value, and the line each value starts on by its path (`stages[1].brief`). The webview's own
 * parser names no position, so this one does.
 */
function scan(text: string): Scan {
  const lines = new Map<string, number>();
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at]!)) at++;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, at)) at += word.length;
    else throw at;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length && text[at] !== '"') {
      if (text.charCodeAt(at) < 0x20) throw at;
      if (text[at] === "\\") {
        const escape = text[at + 1];
        if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) at += 6;
        else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) at += 2;
        else throw at;
      } else {
        at++;
      }
    }
    if (at >= text.length) throw at;
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at));
    if (!match) throw at;
    at += match[0].length;
  };
  const items = (close: string, item: (index: number) => void) => {
    at++;
    space();
    if (text[at] === close) {
      at++;
      return;
    }
    for (let index = 0; ; index++) {
      item(index);
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
  const value = (path: string): void => {
    space();
    if (path) lines.set(path, lineOf(text, at));
    const next = text[at];
    if (next === "{") {
      items("}", () => {
        space();
        if (text[at] !== '"') throw at;
        const key = string();
        space();
        if (text[at] !== ":") throw at;
        at++;
        value(path ? `${path}.${key}` : key);
      });
    } else if (next === "[") items("]", (index) => value(`${path}[${index}]`));
    else if (next === '"') string();
    else if (next === "t") literal("true");
    else if (next === "f") literal("false");
    else if (next === "n") literal("null");
    else number();
  };
  try {
    value("");
    space();
    if (at < text.length) throw at;
    return { error: null, lines };
  } catch (failedAt) {
    return { error: lineOf(text, Math.min(failedAt as number, text.length)), lines };
  }
}

/** The line of the first character that stops {@code text} being one JSON value; 0 when none. */
export function syntaxLine(text: string): number {
  return scan(text).error ?? 0;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * The line of {@code text}, the JSON of {@code section}, that the field a refusal names sits on:
 * sail starts each refusal with the field's path (`pipeline.stages[1].brief ...`). A path naming
 * an element by index is found exactly; one naming none (`repos[].url`) at its first element.
 * Null when the refusal names no field the text holds.
 */
export function refusedLine(
  text: string,
  section: DefinitionSection,
  refusal: string,
): number | null {
  const path = /^([\w-]+(?:\[\d*\])?(?:\.[\w-]+(?:\[\d*\])?)*)(?=[\s,:]|\.?$|\. )/.exec(refusal)?.[1];
  if (!path) return null;
  const within = path.startsWith(`${section}.`)
    ? path.slice(section.length + 1)
    : path;
  const lines = scan(text).lines;
  return lines.get(within) ?? lines.get(within.replace(/\[\]/g, "[0]")) ?? null;
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
