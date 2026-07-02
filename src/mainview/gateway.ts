import type {
  EventStreamState,
  GlobalBoardResponse,
  GlobalSpecContentResponse,
  GlobalSpecDetailResponse,
  GlobalSpecHistoryResponse,
  GlobalSpecsListResponse,
  GlobalSpecView,
  ReviewListResponse,
  SailEvent,
  SpecFilter,
  SpecStatus,
  SpecUpdateRequest,
} from "../shared/sail-models";
import type { SailResult } from "../shared/types";
import { onPush } from "./push";
import type { Bridge } from "./rpc";

/**
 * The webview's seam to the control plane. The real app talks over the
 * Electrobun RPC bridge; the browser dev preview and tests use the demo
 * gateway (seeded in-memory data with the same conflict semantics), so the
 * whole board is drivable without a native shell or a live server.
 */
export type Gateway = {
  listSpecs(filter?: SpecFilter): Promise<SailResult<GlobalSpecsListResponse>>;
  board(project?: string): Promise<SailResult<GlobalBoardResponse>>;
  getSpec(id: string): Promise<SailResult<GlobalSpecDetailResponse>>;
  getSpecContent(id: string): Promise<SailResult<GlobalSpecContentResponse>>;
  updateSpec(
    id: string,
    request: SpecUpdateRequest,
    ifMatch?: string,
  ): Promise<SailResult<GlobalSpecDetailResponse>>;
  specHistory(id: string): Promise<SailResult<GlobalSpecHistoryResponse>>;
  restoreSpec(id: string, rev: number): Promise<SailResult<GlobalSpecDetailResponse>>;
  specReviews(id: string): Promise<SailResult<ReviewListResponse>>;
  connection(): Promise<{ state: EventStreamState; server: string }>;
  onEvent(listener: (event: SailEvent) => void): () => void;
  onStreamState(listener: (state: EventStreamState) => void): () => void;
};

export function createRpcGateway(bridge: Bridge): Gateway {
  const api = bridge.api;
  return {
    listSpecs: (filter) => api.sailListSpecs(filter ?? {}),
    board: (project) => api.sailBoard({ project }),
    getSpec: (id) => api.sailGetSpec({ id }),
    getSpecContent: (id) => api.sailGetSpecContent({ id }),
    updateSpec: (id, request, ifMatch) => api.sailUpdateSpec({ id, request, ifMatch }),
    specHistory: (id) => api.sailSpecHistory({ id }),
    restoreSpec: (id, rev) => api.sailRestoreSpec({ id, rev }),
    specReviews: (id) => api.sailSpecReviews({ id }),
    connection: () => api.sailConnection(),
    onEvent: (listener) => onPush("sail-event", listener),
    onStreamState: (listener) => onPush("sail-stream-state", ({ state }) => listener(state)),
  };
}

/* ------------------------------------------------------------------------- */

type DemoSpec = GlobalSpecView & { body: string; plan: string };

const DEMO_BODY = `# Overview

Stand up the surface end-to-end against the live control plane.

## Scope

1. Wire the **typed client** through the RPC seam
2. Render the board columns from \`GET /v1/specs\`
3. Surface conflicts — never silently overwrite

\`\`\`bash
sail spec dispatch --project chorus
\`\`\`

> Depth comes from 1px rules, never from shadows.
`;

function demoSpec(partial: Partial<DemoSpec> & Pick<DemoSpec, "id" | "project" | "title" | "status">): DemoSpec {
  return {
    priority: 0,
    created_at: "2026-06-28T10:00:00Z",
    updated_at: "2026-07-01T09:00:00Z",
    created_by: "uday",
    body: DEMO_BODY,
    plan: "",
    ...partial,
  };
}

export type DemoGateway = Gateway & { emit(event: SailEvent): void };

export function createDemoGateway(): DemoGateway {
  const specs: DemoSpec[] = [
    demoSpec({ id: "chorus-auth-flow", project: "chorus", title: "Passkey auth flow", status: "draft" }),
    demoSpec({
      id: "chorus-billing-export",
      project: "chorus",
      title: "Billing export to NetSuite",
      status: "pending",
      repos: ["api"],
      assignee: "uday",
      agent: "claude-code",
      model: "claude-fable-5",
      priority: 60,
    }),
    demoSpec({
      id: "chorus-ledger-sync",
      project: "chorus",
      title: "Ledger sync worker",
      status: "pending",
      assignee: "ravi",
      agent: "codex",
      depends_on: ["chorus-billing-export"],
      priority: 40,
    }),
    demoSpec({
      id: "chorus-invoice-ui",
      project: "chorus",
      title: "Invoice review UI",
      status: "in_progress",
      repos: ["web"],
      assignee: "uday",
      agent: "claude-code",
      model: "claude-fable-5",
      branch: "agent/chorus-invoice-ui",
      priority: 80,
    }),
    demoSpec({
      id: "chorus-rate-limits",
      project: "chorus",
      title: "API rate limiting",
      status: "review",
      assignee: "uday",
      agent: "claude-code",
    }),
    demoSpec({ id: "chorus-onboarding", project: "chorus", title: "Tenant onboarding", status: "done" }),
    demoSpec({
      id: "mast-terminal",
      project: "sail-mast",
      title: "Mast terminal: ghostty-web over the SSH lane",
      status: "pending",
      assignee: "uday",
      depends_on: ["mast-api-client", "mast-design-system"],
    }),
    demoSpec({
      id: "mast-kanban-board",
      project: "sail-mast",
      title: "Mast board: projects, contracts & spec kanban",
      status: "in_progress",
      repos: ["mast"],
      assignee: "uday",
      agent: "claude-code",
      model: "claude-fable-5",
      priority: 90,
    }),
    demoSpec({ id: "mast-api-client", project: "sail-mast", title: "Typed control-plane client", status: "done" }),
    demoSpec({ id: "mast-design-system", project: "sail-mast", title: "The SAIL theme", status: "done" }),
  ];

  const listeners = new Set<(event: SailEvent) => void>();
  let eventId = 100;

  const ok = <T>(value: T, etag?: string): SailResult<T> => ({ ok: true, value, etag });
  const notFound = <T>(id: string): SailResult<T> => ({
    ok: false,
    error: { status: 404, code: "spec_not_found", message: `No spec '${id}'` },
  });
  const find = (id: string) => specs.find((s) => s.id === id);
  const etagOf = (spec: DemoSpec) => `"${spec.updated_at}"`;

  const emit = (event: SailEvent) => listeners.forEach((l) => l(event));

  const view = ({ body: _b, plan: _p, ...spec }: DemoSpec): GlobalSpecView => spec;

  return {
    async listSpecs(filter = {}) {
      const assignee = filter.assignee === "me" ? "uday" : filter.assignee;
      const matched = specs.filter(
        (s) =>
          (!filter.project || s.project === filter.project) &&
          (!filter.status || s.status === filter.status) &&
          (!assignee || s.assignee === assignee) &&
          (!filter.repo || s.repos?.includes(filter.repo)) &&
          (!filter.q || `${s.id} ${s.title}`.toLowerCase().includes(filter.q.toLowerCase())),
      );
      return ok({ specs: matched.map(view), total: matched.length });
    },

    async board(project) {
      const scoped = specs.filter((s) => !project || s.project === project);
      const count = (status: SpecStatus) => scoped.filter((s) => s.status === status).length;
      return ok({
        draft: count("draft"),
        pending: count("pending"),
        in_progress: count("in_progress"),
        review: count("review"),
        done: count("done"),
        archived: count("archived"),
        next_ready_id: scoped.find((s) => s.status === "pending" && !s.depends_on?.length)?.id,
        done_open_findings: 0,
      });
    },

    async getSpec(id) {
      const spec = find(id);
      if (!spec) return notFound(id);
      return ok({ spec: view(spec), body: spec.body }, etagOf(spec));
    },

    async getSpecContent(id) {
      const spec = find(id);
      if (!spec) return notFound(id);
      return ok({ spec_id: id, body: spec.body, plan: spec.plan });
    },

    async updateSpec(id, request, ifMatch) {
      const spec = find(id);
      if (!spec) return notFound(id);
      if (ifMatch && ifMatch !== "*" && ifMatch !== etagOf(spec)) {
        return {
          ok: false,
          error: {
            status: 412,
            code: "precondition_failed",
            message: `Spec '${id}' was modified by another writer.`,
            action: "Re-GET the spec, replay your changes against the fresh ETag, then retry.",
          },
        };
      }
      const previous = spec.status;
      Object.assign(spec, request, { updated_at: new Date().toISOString(), updated_by: "uday" });
      if (request.status && request.status !== previous) {
        emit({
          v: 1,
          id: ++eventId,
          ts: spec.updated_at,
          project: spec.project,
          spec: id,
          type: "spec_status_changed",
          agent: "mast",
          host: "demo",
          data: { from: previous, to: request.status },
        });
      }
      return ok({ spec: view(spec) }, etagOf(spec));
    },

    async specHistory(id) {
      if (!find(id)) return notFound(id);
      return ok({
        spec_id: id,
        revisions: [
          { rev: 3, actor: "uday", recorded_at: "2026-07-01T09:00:00Z", origin: "update", deleted: false },
          { rev: 2, actor: "agent", recorded_at: "2026-06-30T16:00:00Z", origin: "sync", deleted: false },
          { rev: 1, actor: "uday", recorded_at: "2026-06-28T10:00:00Z", origin: "create", deleted: false },
        ],
        total: 3,
      });
    },

    async restoreSpec(id) {
      const spec = find(id);
      if (!spec) return notFound(id);
      spec.updated_at = new Date().toISOString();
      return ok({ spec: view(spec) }, etagOf(spec));
    },

    async specReviews(id) {
      if (!find(id)) return notFound(id);
      const reviews =
        find(id)?.status === "review"
          ? [
              {
                id: "rev-1",
                spec_id: id,
                iteration: 1,
                status: "pending_decision",
                created_at: "2026-07-01T12:00:00Z",
                stages: [
                  {
                    id: "st-1",
                    name: "correctness",
                    stage_type: "checker",
                    status: "completed",
                    finding_count: 2,
                  },
                ],
              },
            ]
          : [];
      return ok({ spec_id: id, reviews });
    },

    async connection() {
      return { state: "connected", server: "demo fixtures (browser preview)" };
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onStreamState(listener) {
      listener("connected");
      return () => {};
    },

    emit,
  };
}
