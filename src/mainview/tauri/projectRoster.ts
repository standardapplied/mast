import type { ProjectContainerStatus, ProjectListItem, ProjectListResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";

/**
 * The terminal picker's project roster: the synced catalog (`GET /v1/projects`,
 * authoritative — every project regardless of running state or which box hosts
 * it) merged with the `~/.ssh/config` ProxyJump aliases (the routes a terminal
 * can actually dial). Either source may fail independently; the roster degrades
 * to the surviving one with a warning instead of going blank.
 */

export type RosterSources = {
  listProjects(): Promise<SailResult<ProjectListResponse>>;
  listTargets(): Promise<string[]>;
};

export type ProjectRow = {
  name: string;
  status?: ProjectContainerStatus;
  connectable: boolean;
};

export type Roster = {
  rows: ProjectRow[];
  warning?: string;
  error?: string;
};

/**
 * Union of catalog and SSH routes, sorted by name. A row is connectable only
 * when a route exists and the container is running; with no catalog entry
 * (route-only row, or catalog unavailable) the route alone decides, matching
 * the picker's historical behavior.
 */
export function mergeRoster(projects: ProjectListItem[], targets: string[]): ProjectRow[] {
  const routes = new Set(targets);
  const rows = new Map<string, ProjectRow>();
  for (const target of targets) {
    rows.set(target, { name: target, connectable: true });
  }
  for (const project of projects) {
    rows.set(project.name, {
      name: project.name,
      status: project.container_status,
      connectable: routes.has(project.name) && project.container_status === "running",
    });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The row's meta label (status column). */
export function rowMeta(row: ProjectRow): string {
  if (row.status === undefined) return "project container";
  if (row.status === "running" && !row.connectable) return "running · no ssh route";
  return row.status === "not_created" ? "not created" : row.status;
}

/** Why a row can't open a terminal (tooltip on disabled rows). */
export function rowHint(row: ProjectRow): string | undefined {
  if (row.connectable) return undefined;
  switch (row.status) {
    case "running":
      return `No SSH route yet — run \`sail connect ${row.name}\` on your Mac to add one.`;
    case "stopped":
      return "The container is stopped — start it to open a terminal.";
    case "not_created":
      return "Catalogued on the project roster, but no container exists on this box.";
    case "error":
      return "The container is in an error state.";
    default:
      return "No SSH route to this project.";
  }
}

/**
 * Load both sources concurrently and merge. Never rejects: a single failed
 * source yields a partial roster plus `warning`; both failing yields `error`.
 */
export async function loadRoster(sources: RosterSources): Promise<Roster> {
  const [catalog, targets] = await Promise.all([
    loadCatalog(sources),
    loadTargets(sources),
  ]);
  if (!catalog.ok && !targets.ok) {
    return { rows: [], error: `${catalog.detail}; ${targets.detail}` };
  }
  const rows = mergeRoster(catalog.ok ? catalog.projects : [], targets.ok ? targets.names : []);
  const warning = catalog.ok
    ? targets.ok
      ? undefined
      : `Couldn’t read SSH routes (${targets.detail}) — terminals are unavailable.`
    : `Couldn’t load the project catalog (${catalog.detail}) — showing SSH routes only.`;
  return { rows, warning };
}

type CatalogLoad = { ok: true; projects: ProjectListItem[] } | { ok: false; detail: string };
type TargetsLoad = { ok: true; names: string[] } | { ok: false; detail: string };

async function loadCatalog(sources: RosterSources): Promise<CatalogLoad> {
  let result: SailResult<ProjectListResponse>;
  try {
    result = await sources.listProjects();
  } catch (error) {
    return { ok: false, detail: message(error) };
  }
  if (!result.ok) return { ok: false, detail: result.error.message };
  if (!Array.isArray(result.value.projects)) {
    return { ok: false, detail: "malformed /v1/projects response" };
  }
  return { ok: true, projects: result.value.projects };
}

async function loadTargets(sources: RosterSources): Promise<TargetsLoad> {
  try {
    const names = await sources.listTargets();
    return { ok: true, names };
  } catch (error) {
    return { ok: false, detail: message(error) };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
