import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlobalSpecView, SpecFilter, SpecStatus } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import type { Gateway } from "../gateway";

export type MoveOutcome = "ok" | "conflict" | "blocked" | "error";
export type MoveResult = { outcome: MoveOutcome; error?: SailWireError };

export type BoardData = {
  specs: GlobalSpecView[];
  projects: string[];
  repos: string[];
  loading: boolean;
  error: SailWireError | null;
};

const RELOAD_EVENT_TYPES = /^(spec_|board_updated)/;

/**
 * Board state for one project + filter: loads specs and the summary, refreshes
 * on relevant SSE events (event-driven, not polling), and moves specs with
 * If-Match built from the updated_at captured at load — a concurrent writer
 * surfaces as a "conflict" outcome and a fresh reload, never an overwrite.
 *
 * The project list is the synced catalog (`GET /v1/projects`) unioned with the
 * projects the specs reference, so a catalogued project with no specs still
 * shows and a catalog outage degrades to the specs-derived list.
 */
export function useBoard(gateway: Gateway, project: string | undefined, filter: SpecFilter) {
  const [data, setData] = useState<BoardData>({
    specs: [],
    projects: [],
    repos: [],
    loading: true,
    error: null,
  });
  const generation = useRef(0);

  const filterKey = `${filter.assignee ?? ""}|${filter.q ?? ""}|${filter.repo ?? ""}`;

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    let all, scoped, catalog;
    try {
      [all, scoped, catalog] = await Promise.all([
        gateway.listSpecs({}),
        gateway.listSpecs({ ...filter, project }),
        catalogProjects(gateway),
      ]);
    } catch (error) {
      // A rejecting RPC (bridge failure) must not leave "Loading specs" forever.
      if (gen !== generation.current) return;
      setData((prev) => ({
        ...prev,
        loading: false,
        error: { status: 0, code: "bridge", message: message(error) },
      }));
      return;
    }
    if (gen !== generation.current) return;

    if (!scoped.ok) {
      setData((prev) => ({ ...prev, loading: false, error: scoped.error }));
      return;
    }
    const specProjects = all.ok ? all.value.specs.map((s) => s.project) : [];
    const projects = [...new Set([...catalog, ...specProjects])].sort();
    const repos = all.ok
      ? [...new Set(all.value.specs.flatMap((s) => s.repos ?? []))].sort()
      : [];
    setData({
      specs: scoped.value.specs,
      projects,
      repos,
      loading: false,
      error: null,
    });
  }, [gateway, project, filterKey]);

  useEffect(() => {
    setData((prev) => ({ ...prev, loading: true }));
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let queued = false;
    return gateway.onEvent((event) => {
      if (!RELOAD_EVENT_TYPES.test(event.type)) return;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void refresh();
      });
    });
  }, [gateway, refresh]);

  const move = useCallback(
    async (id: string, to: SpecStatus): Promise<MoveResult> => {
      const spec = data.specs.find((s) => s.id === id);
      if (!spec) return { outcome: "error" };

      const result = await gateway.updateSpec(id, { status: to }, `"${spec.updated_at}"`);
      if (result.ok) {
        setData((prev) => ({
          ...prev,
          specs: prev.specs.map((s) => (s.id === id ? result.value.spec : s)),
        }));
        void refresh();
        return { outcome: "ok" };
      }
      if (result.error.status === 412) {
        void refresh();
        return { outcome: "conflict", error: result.error };
      }
      return { outcome: "error", error: result.error };
    },
    [gateway, data.specs, refresh],
  );

  const byStatus = useMemo(() => {
    const groups = new Map<SpecStatus, GlobalSpecView[]>();
    for (const spec of data.specs) {
      const list = groups.get(spec.status) ?? [];
      list.push(spec);
      groups.set(spec.status, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    }
    return groups;
  }, [data.specs]);

  return { data, byStatus, refresh, move };
}

/** Reverse edges: which specs depend on `id` (blocked-by view for detail). */
export function dependentsOf(specs: GlobalSpecView[], id: string): GlobalSpecView[] {
  return specs.filter((s) => s.depends_on?.includes(id));
}

/**
 * The foreign assignee whose box holds this spec's run logs, or undefined when
 * they are followable from here. Runs execute on the assignee's box, so a spec
 * assigned to someone else has no local logs — the server refuses the stream
 * with run_on_other_node. Unknown identity or an unassigned spec stays
 * followable: the server remains the authority and its refusal is surfaced.
 */
export function logsElsewhere(
  spec: { assignee?: string },
  fde: string | undefined,
): string | undefined {
  return fde && spec.assignee && spec.assignee !== fde ? spec.assignee : undefined;
}

/** Unmet = a dependency that is not done (mirrors the server's readiness rule). */
export function unmetDependencies(spec: GlobalSpecView, all: GlobalSpecView[]): string[] {
  return (spec.depends_on ?? []).filter((dep) => {
    const target = all.find((s) => s.id === dep);
    return !target || target.status !== "done";
  });
}

/** Catalog names, or [] on any failure — the roster must never break the board. */
async function catalogProjects(gateway: Gateway): Promise<string[]> {
  try {
    const result = await gateway.listProjects();
    if (!result.ok || !Array.isArray(result.value.projects)) return [];
    return result.value.projects.map((p) => p.name);
  } catch {
    return [];
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
