import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GlobalSpecView, SpecFilter, SpecStatus } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import type { Gateway } from "../gateway";
import { CatalogStore, catalogStore, connectCatalog } from "./catalogStore";

export type { MoveOutcome, MoveResult } from "./catalogStore";

export type BoardData = {
  specs: GlobalSpecView[];
  projects: string[];
  repos: string[];
  loading: boolean;
  error: SailWireError | null;
};

/**
 * The board's selector over the app-wide catalog store: one world spec list,
 * filtered client-side per project + filter (mirroring the server's filter
 * semantics), so switching scope is instant and no surface holds a second
 * copy. Moves route through the store, which builds If-Match from the row it
 * owns — a concurrent writer surfaces as a "conflict" outcome and a scoped
 * refetch of that spec, never an overwrite.
 *
 * The project list is the synced catalog (`GET /v1/projects`) unioned with the
 * projects the specs reference, so a catalogued project with no specs still
 * shows and a catalog outage degrades to the specs-derived list.
 */
export function useBoard(
  gateway: Gateway,
  project: string | undefined,
  filter: SpecFilter,
  store: CatalogStore = catalogStore,
) {
  useEffect(() => connectCatalog(gateway, store), [gateway, store]);
  const version = useSyncExternalStore(store.subscribe, () => store.version);

  const filterKey = `${filter.assignee ?? ""}|${filter.q ?? ""}|${filter.repo ?? ""}`;

  const data = useMemo<BoardData>(() => {
    const all = store.specList();
    return {
      specs: all.filter((spec) => matchesFilter(spec, { ...filter, project }, store.me)),
      projects: [...new Set([...store.projects(), ...all.map((spec) => spec.project)])].sort(),
      repos: [...new Set(all.flatMap((spec) => spec.repos ?? []))].sort(),
      loading: !store.seeded && store.boardError === null,
      error: store.boardError,
    };
    // version is the store's change signal; the selectors read fresh state through it.
  }, [store, version, project, filterKey]);

  const refresh = useCallback(() => store.refreshAll(), [store]);
  const move = useCallback(
    (id: string, to: SpecStatus) => store.moveSpec(id, to),
    [store],
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

/**
 * The server's spec-filter semantics applied client-side: project/status/repo
 * exact, `q` substring on id+title, assignee exact with "me" resolved to the
 * caller's handle — and matching nobody until that handle is known, so an
 * unresolved "me" never means "everyone".
 */
export function matchesFilter(
  spec: GlobalSpecView,
  filter: SpecFilter,
  me: string | undefined,
): boolean {
  if (filter.assignee === "me" && !me) return false;
  const assignee = filter.assignee === "me" ? me : filter.assignee;
  return (
    (!filter.project || spec.project === filter.project) &&
    (!filter.status || spec.status === filter.status) &&
    (!assignee || spec.assignee === assignee) &&
    (!filter.repo || spec.repos?.includes(filter.repo) === true) &&
    (!filter.q || `${spec.id} ${spec.title}`.toLowerCase().includes(filter.q.toLowerCase()))
  );
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
