import type {
  ConnectionStatus,
  DispatchRequest,
  DispatchResponse,
  GlobalBoardResponse,
  GlobalSpecContentResponse,
  GlobalSpecDetailResponse,
  GlobalSpecHistoryResponse,
  GlobalSpecsListResponse,
  GlobalSpecView,
  ReviewListResponse,
  SailEvent,
  SpecContentRequest,
  SpecFilter,
  SpecStatus,
  SpecUpdateRequest,
  WhoAmI,
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
  putSpecContent(
    id: string,
    content: SpecContentRequest,
    ifMatch?: string,
  ): Promise<SailResult<GlobalSpecContentResponse>>;
  updateSpec(
    id: string,
    request: SpecUpdateRequest,
    ifMatch?: string,
  ): Promise<SailResult<GlobalSpecDetailResponse>>;
  specHistory(id: string): Promise<SailResult<GlobalSpecHistoryResponse>>;
  restoreSpec(id: string, rev: number): Promise<SailResult<GlobalSpecDetailResponse>>;
  specReviews(id: string): Promise<SailResult<ReviewListResponse>>;
  dispatch(project: string, request: DispatchRequest): Promise<SailResult<DispatchResponse>>;
  whoami(): Promise<SailResult<WhoAmI>>;
  connection(): Promise<ConnectionStatus>;
  login(): Promise<{ ok: boolean; detail?: string }>;
  logout(): Promise<void>;
  diagnostics(): Promise<{ report: string; logPath: string }>;
  onEvent(listener: (event: SailEvent) => void): () => void;
  onConnectionStatus(listener: (status: ConnectionStatus) => void): () => void;
};

/**
 * The Electrobun RPC bridge (webview↔Bun socket) can drop or time out a
 * response under load even when the HTTP call behind it succeeded — a
 * transient status-0 that is NOT a real network failure. Retry reads a couple
 * of times with a short backoff so a bridge blip self-heals instead of
 * surfacing as a spurious "can't reach the control plane". Writes are not
 * retried here (the caller owns idempotency and conflict handling).
 */
export type RetrySleep = (ms: number) => Promise<void>;

const realSleep: RetrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryRead<T>(
  call: () => Promise<SailResult<T>>,
  sleep: RetrySleep,
  attempts = 3,
): Promise<SailResult<T>> {
  for (let attempt = 1; ; attempt++) {
    let result: SailResult<T>;
    try {
      result = await call();
    } catch (error) {
      if (attempt >= attempts) {
        return { ok: false, error: { status: 0, code: "bridge", message: String(error) } };
      }
      await sleep(150 * attempt);
      continue;
    }
    if (result.ok || result.error.status !== 0 || attempt >= attempts) return result;
    await sleep(150 * attempt);
  }
}

export function createRpcGateway(bridge: Bridge, sleep: RetrySleep = realSleep): Gateway {
  const api = bridge.api;
  const read = <T>(call: () => Promise<SailResult<T>>) => retryRead(call, sleep);
  return {
    listSpecs: (filter) => read(() => api.sailListSpecs(filter ?? {})),
    board: (project) => read(() => api.sailBoard({ project })),
    getSpec: (id) => read(() => api.sailGetSpec({ id })),
    getSpecContent: (id) => read(() => api.sailGetSpecContent({ id })),
    putSpecContent: (id, content, ifMatch) => api.sailPutSpecContent({ id, content, ifMatch }),
    updateSpec: (id, request, ifMatch) => api.sailUpdateSpec({ id, request, ifMatch }),
    specHistory: (id) => read(() => api.sailSpecHistory({ id })),
    restoreSpec: (id, rev) => api.sailRestoreSpec({ id, rev }),
    specReviews: (id) => read(() => api.sailSpecReviews({ id })),
    dispatch: (project, request) => api.sailDispatch({ project, request }),
    whoami: () => api.sailWhoami(),
    connection: () => api.sailConnection(),
    login: () => api.sailLogin(),
    logout: () => api.sailLogout(),
    diagnostics: () => api.sailDiagnostics(),
    onEvent: (listener) => onPush("sail-event", listener),
    onConnectionStatus: (listener) => onPush("connection-status", listener),
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
    demoSpec({
      id: "chorus-webhooks",
      project: "chorus",
      title: "Outbound webhooks",
      status: "awaiting_merge",
      assignee: "ravi",
      agent: "claude-code",
      branch: "agent/chorus-webhooks",
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
        awaiting_merge: count("awaiting_merge"),
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

    async putSpecContent(id, content, ifMatch) {
      const spec = find(id);
      if (!spec) return notFound(id);
      if (ifMatch && ifMatch !== "*" && ifMatch !== etagOf(spec)) {
        return {
          ok: false,
          error: {
            status: 412,
            code: "precondition_failed",
            message: `Spec '${id}' was modified by another writer.`,
          },
        };
      }
      if (content.body !== undefined) spec.body = content.body;
      if (content.plan !== undefined) spec.plan = content.plan;
      spec.updated_at = new Date().toISOString();
      return ok({ spec_id: id, body: spec.body, plan: spec.plan }, etagOf(spec));
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

    async whoami() {
      return {
        ok: true,
        value: {
          fde: "uday",
          name: "uday",
          display_name: "Uday K",
          email: "uday@singlr.ai",
          role: "admin",
          capabilities: ["read", "write", "admin"],
        },
      };
    },

    async dispatch(_project, request) {
      const spec = request.specId ? find(request.specId) : undefined;
      if (!spec) return { ok: true, value: demoDispatch(false, "no_pending_specs") };
      spec.status = "in_progress";
      spec.updated_at = new Date().toISOString();
      emit({
        v: 1,
        id: ++eventId,
        ts: spec.updated_at,
        project: spec.project,
        spec: spec.id,
        type: "spec_dispatched",
        agent: "mast",
        host: "demo",
      });
      return { ok: true, value: demoDispatch(true) };
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
      return DEMO_STATUS;
    },

    async login() {
      return { ok: true };
    },

    async logout() {},

    async diagnostics() {
      return {
        report: "=== Mast diagnostics ===\nDemo gateway (browser preview) — no live connection.",
        logPath: "(browser preview)",
      };
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onConnectionStatus(listener) {
      listener(DEMO_STATUS);
      return () => {};
    },

    emit,
  };
}

function demoDispatch(dispatched: boolean, reason = ""): DispatchResponse {
  return { name: "demo", dispatched, reason, branch_created: dispatched };
}

const DEMO_STATUS: ConnectionStatus = {
  phase: "ready",
  server: "demo fixtures (browser preview)",
  loginOrigin: "http://localhost:7070",
  tokenPresent: true,
  tokenKind: "session",
  stream: "connected",
};
