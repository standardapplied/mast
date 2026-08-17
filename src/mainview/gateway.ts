import type {
  AgentListResponse,
  AgentLogResponse,
  AgentLogRole,
  ConnectionStatus,
  DispatchRequest,
  DispatchResponse,
  FdeListResponse,
  InviteRequest,
  InviteResponse,
  GlobalBoardResponse,
  GlobalSpecContentResponse,
  GlobalSpecDetailResponse,
  GlobalSpecHistoryResponse,
  GlobalSpecsListResponse,
  GlobalSpecView,
  ProjectListResponse,
  RecentEventsResponse,
  ReviewDetailResponse,
  ReviewListResponse,
  ReviewApproveResponse,
  FindingDismissResponse,
  RunListResponse,
  SailEvent,
  SpecContentRequest,
  SpecCreateRequest,
  SpecFilter,
  SpecMessage,
  SpecMessageListResponse,
  SpecMessagePostRequest,
  SpecMessagePostResponse,
  SpecStatus,
  SpecUpdateRequest,
  StopRunResponse,
  WhoAmI,
} from "../shared/sail-models";
import type { SailResult } from "../shared/types";
import type { AgentLogLine, AgentLogState } from "./tauri/agentLogStream";

/**
 * A live agent-log follow session for one spec+role. The stream owns reconnect
 * and the `since` cursor internally; callers just consume lines, stream state,
 * and terminal errors (a server refusal that reconnecting cannot fix), and
 * `stop()` when done. Switching role is a fresh follow.
 */
export type AgentLogHandle = {
  onLine(listener: (line: AgentLogLine) => void): () => void;
  onState(listener: (state: AgentLogState) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  stop(): void;
};

/**
 * The webview's seam to the control plane. The app is backed by the Tauri
 * gateway; the browser dev preview and tests use the demo gateway (seeded
 * in-memory data with the same conflict semantics), so the whole board is
 * drivable without a native shell or a live server.
 */
export type Gateway = {
  listSpecs(filter?: SpecFilter): Promise<SailResult<GlobalSpecsListResponse>>;
  board(project?: string): Promise<SailResult<GlobalBoardResponse>>;
  getSpec(id: string): Promise<SailResult<GlobalSpecDetailResponse>>;
  createSpec(request: SpecCreateRequest): Promise<SailResult<GlobalSpecDetailResponse>>;
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
  listSpecMessages(
    id: string,
    before?: string,
    limit?: number,
  ): Promise<SailResult<SpecMessageListResponse>>;
  postSpecMessage(
    id: string,
    request: SpecMessagePostRequest,
  ): Promise<SailResult<SpecMessagePostResponse>>;
  /** One review with its full findings (GET /v1/reviews/{id}). */
  reviewDetail(reviewId: string): Promise<SailResult<ReviewDetailResponse>>;
  approveReview(reviewId: string): Promise<SailResult<ReviewApproveResponse>>;
  dismissFinding(
    reviewId: string,
    findingId: string,
  ): Promise<SailResult<FindingDismissResponse>>;
  recentEvents(limit?: number): Promise<SailResult<RecentEventsResponse>>;
  dispatch(project: string, request: DispatchRequest): Promise<SailResult<DispatchResponse>>;
  whoami(): Promise<SailResult<WhoAmI>>;
  /** The full synced project roster — every catalogued project with its local container state. */
  listProjects(): Promise<SailResult<ProjectListResponse>>;
  /** The org's FDE roster — the assignee candidates for a spec. */
  listFdes(): Promise<SailResult<FdeListResponse>>;
  /** The installable agents and their invite-mode support (GET /v1/agents) — sail ≥ 0.23. */
  listAgents(): Promise<SailResult<AgentListResponse>>;
  /** Invite an agent into a spec's room (POST /v1/specs/{id}/invite): read only or full. */
  invite(id: string, request: InviteRequest): Promise<SailResult<InviteResponse>>;
  /** Execution history (GET /v1/runs?spec=), or every run when no spec is
   *  given — the log panel's header and the presence store's seed. */
  listRuns(specId?: string): Promise<SailResult<RunListResponse>>;
  /** Clean-stop a running run (POST /v1/runs/{id}/stop) — sail ≥ v0.13.172. */
  stopRun(runId: string): Promise<SailResult<StopRunResponse>>;
  /** A `tail -n` snapshot of the spec's newest run log, for instant content on open. */
  agentLogSnapshot(
    specId: string,
    role: AgentLogRole,
    tail: number,
  ): Promise<SailResult<AgentLogResponse>>;
  /** Begin following the spec's newest run log live from `since` (0 = live tail). */
  followAgentLog(specId: string, role: AgentLogRole, since: number): AgentLogHandle;
  connection(): Promise<ConnectionStatus>;
  login(): Promise<{ ok: boolean; detail?: string }>;
  logout(): Promise<void>;
  diagnostics(): Promise<{ report: string; logPath: string }>;
  onEvent(listener: (event: SailEvent) => void): () => void;
  onConnectionStatus(listener: (status: ConnectionStatus) => void): () => void;
};

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

const DEMO_BUILD_LOG = [
  `{"type":"system","subtype":"init","model":"claude-fable-5"}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the spec and the surrounding board code."}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result","content":"42 pass"}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"Tests pass — wiring the live-log panel now."}]}}`,
];

const DEMO_REVIEW_LOG = [
  `{"type":"assistant","message":{"content":[{"type":"text","text":"Reviewing the diff for correctness and reuse."}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/mainview/board/LiveLog.tsx"}}]}}`,
  `{"type":"result","subtype":"success","result":"No blocking findings; two minor suggestions."}`,
];

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
      needs_reply: true,
      question_message_id: "demo-question-1",
    }),
    demoSpec({ id: "mast-api-client", project: "sail-mast", title: "Typed control-plane client", status: "done" }),
    demoSpec({ id: "mast-design-system", project: "sail-mast", title: "The SAIL theme", status: "done" }),
  ];

  const listeners = new Set<(event: SailEvent) => void>();
  const events: SailEvent[] = [];
  const messages = new Map<string, SpecMessage[]>();
  let eventId = 100;

  const ok = <T>(value: T, etag?: string): SailResult<T> => ({ ok: true, value, etag });
  const notFound = <T>(id: string): SailResult<T> => ({
    ok: false,
    error: { status: 404, code: "spec_not_found", message: `No spec '${id}'` },
  });
  const find = (id: string) => specs.find((s) => s.id === id);
  const etagOf = (spec: DemoSpec) => `"${spec.updated_at}"`;

  const emit = (event: SailEvent) => {
    events.push(event);
    listeners.forEach((l) => l(event));
  };

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
        cancelled: count("cancelled"),
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

    async createSpec(request) {
      if (find(request.id)) {
        return {
          ok: false,
          error: {
            status: 409,
            code: "spec_exists",
            message: `Spec '${request.id}' already exists.`,
          },
        };
      }
      const now = new Date().toISOString();
      const spec = demoSpec({
        ...request,
        project: request.project ?? "",
        status: request.status ?? "draft",
        created_at: now,
        updated_at: now,
      });
      specs.push(spec);
      emit({
        v: 1,
        id: ++eventId,
        ts: now,
        project: spec.project,
        spec: spec.id,
        type: "spec_created",
        agent: "mast",
        host: "demo",
      });
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

    async listProjects() {
      return ok({
        projects: [
          { name: "chorus", container_status: "running" as const },
          { name: "nautilus", container_status: "not_created" as const },
          { name: "sail-mast", container_status: "stopped" as const },
        ],
      });
    },

    async listFdes() {
      return ok({
        fdes: [
          { handle: "ravi", display_name: "Ravi N", role: "member" },
          { handle: "sumesh", display_name: "Sumesh P", role: "member" },
          { handle: "uday", display_name: "Uday K", role: "admin" },
        ],
      });
    },

    async listAgents() {
      // Faithful to the control plane: mode support is declared at the server's
      // agent seam, and the refusal reason travels so the dialog greys honestly.
      return ok({
        agents: [
          {
            name: "claude-code",
            display_name: "Claude Code",
            modes: [
              { mode: "read_only" as const, supported: true },
              { mode: "full" as const, supported: true },
            ],
          },
          {
            name: "codex",
            display_name: "Codex CLI",
            modes: [
              {
                mode: "read_only" as const,
                supported: false,
                reason:
                  "Codex CLI has no harness-enforced read-only session inside a sail container." +
                  " Invite it with full access instead.",
              },
              { mode: "full" as const, supported: true },
            ],
          },
        ],
      });
    },

    async invite(id, request) {
      const spec = find(id);
      if (!spec) {
        return {
          ok: false,
          error: { status: 404, code: "spec_not_found", message: `Spec '${id}' was not found.` },
        };
      }
      if (!request.full && request.agent === "codex") {
        return {
          ok: false,
          error: {
            status: 400,
            code: "bad_request",
            message:
              "Codex CLI has no harness-enforced read-only session inside a sail container.",
            action: "Invite codex with full access, or invite claude-code read-only.",
          },
        };
      }
      const runId = `run-${++eventId}`;
      const family = request.agent.split("-")[0];
      if (request.full) {
        emit({
          v: 1,
          id: ++eventId,
          ts: new Date().toISOString(),
          project: spec.project,
          spec: spec.id,
          type: "snapshot_created",
          agent: "sail",
          host: "demo",
          data: { label: `invite-${runId}`, run_id: runId },
        });
      }
      return ok({
        run_id: runId,
        principal: `${family}/invite-${runId}`,
        mode: request.full ? ("full" as const) : ("read_only" as const),
        snapshot: request.full ? `invite-${runId}` : "",
      });
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

    async listRuns(specId) {
      const runsFor = (spec: DemoSpec) => {
        const active = spec.status === "in_progress" || spec.status === "review";
        const run = (role: "build" | "review", status: string) => ({
          id: `demo-run-${spec.id}-${role}`,
          project: spec.project,
          spec_id: spec.id,
          node: "demo",
          role,
          agent: "claude-code",
          branch: spec.branch ?? `agent/${spec.id}`,
          status,
          started_at: role === "build" ? "2026-07-08T11:30:00Z" : "2026-07-08T12:10:00Z",
          ...(status === "completed" ? { completed_at: "2026-07-08T12:05:00Z", exit_code: 0 } : {}),
          ...(status === "running"
            ? { last_activity_at: new Date().toISOString(), presence: "working" as const }
            : {}),
        });
        return !active
          ? []
          : spec.status === "in_progress"
            ? [run("build", "running")]
            : [run("build", "completed"), run("review", "running")];
      };
      if (!specId) {
        return ok({ runs: specs.flatMap(runsFor) });
      }
      const spec = find(specId);
      return ok({ spec: specId, runs: spec ? runsFor(spec) : [] });
    },

    async stopRun(runId) {
      const spec = specs.find((s) => runId === `demo-run-${s.id}-build`);
      if (!spec || spec.status !== "in_progress") {
        return {
          ok: false,
          error: { status: 404, code: "run_not_found", message: `No running run '${runId}'` },
        };
      }
      const previous = spec.status;
      spec.status = "cancelled";
      spec.updated_at = new Date().toISOString();
      emit({
        v: 1,
        id: ++eventId,
        ts: spec.updated_at,
        project: spec.project,
        spec: spec.id,
        type: "agent_cancelled",
        agent: "mast",
        host: "demo",
        data: { run: runId },
      });
      emit({
        v: 1,
        id: ++eventId,
        ts: spec.updated_at,
        project: spec.project,
        spec: spec.id,
        type: "spec_status_changed",
        agent: "mast",
        host: "demo",
        data: { from: previous, to: "cancelled" },
      });
      return ok({ run_id: runId, stopped: true, spec_cancelled: true });
    },

    async agentLogSnapshot(_specId, role, tail) {
      const lines = role === "review" ? DEMO_REVIEW_LOG : DEMO_BUILD_LOG;
      return ok({ run_id: `demo-run-${role}`, lines: lines.slice(-tail) });
    },

    followAgentLog(_specId, role, since) {
      const lineListeners = new Set<(line: AgentLogLine) => void>();
      const stateListeners = new Set<(state: AgentLogState) => void>();
      const source = role === "review" ? DEMO_REVIEW_LOG : DEMO_BUILD_LOG;
      let stopped = false;
      queueMicrotask(() => {
        if (stopped) return;
        stateListeners.forEach((l) => l("connected"));
        source.forEach((text, i) => lineListeners.forEach((l) => l({ id: since + i + 1, text })));
      });
      return {
        onLine: (l) => {
          lineListeners.add(l);
          return () => lineListeners.delete(l);
        },
        onState: (l) => {
          stateListeners.add(l);
          return () => stateListeners.delete(l);
        },
        onError: () => () => {},
        stop: () => {
          stopped = true;
        },
      };
    },

    async dispatch(_project, request) {
      const spec = request.spec_id ? find(request.spec_id) : undefined;
      if (!spec) return { ok: true, value: demoDispatch(false, "no_pending_specs") };
      // Faithful to the control plane: a non-pending spec needs restart, which
      // atomically resets it to pending before dispatching.
      const restarted = request.restart === true && spec.status !== "pending";
      if (spec.status !== "pending" && !restarted) {
        return {
          ok: false,
          error: {
            status: 409,
            code: "SPEC_NOT_READY",
            message: `Spec '${spec.id}' is ${spec.status}, not pending.`,
            action: "Re-dispatch with restart to reset it to pending and relaunch.",
          },
        };
      }
      const previous = spec.status;
      spec.status = "in_progress";
      spec.updated_at = new Date().toISOString();
      if (restarted) {
        emit({
          v: 1,
          id: ++eventId,
          ts: spec.updated_at,
          project: spec.project,
          spec: spec.id,
          type: "spec_restarted",
          agent: "mast",
          host: "demo",
          data: { previous_status: previous },
        });
      }
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
      return { ok: true, value: { ...demoDispatch(true), restarted } };
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

    async listSpecMessages(id, before, limit = 50) {
      if (!find(id)) return notFound(id);
      const all = messages.get(id) ?? [];
      const end = before ? all.findIndex((message) => message.id === before) : all.length;
      const pageEnd = end < 0 ? all.length : end;
      const page = all.slice(Math.max(0, pageEnd - limit), pageEnd);
      return ok({ spec_id: id, messages: page, total: page.length });
    },

    async postSpecMessage(id, request) {
      if (!find(id)) return notFound(id);
      const message: SpecMessage = {
        id: crypto.randomUUID(),
        spec_id: id,
        author: "uday",
        body: request.body,
        created_at: new Date().toISOString(),
        ...(request.reply_to ? { reply_to: request.reply_to } : {}),
        ...(request.question ? { question: true } : {}),
      };
      messages.set(id, [...(messages.get(id) ?? []), message]);
      emit({
        v: 1,
        id: ++eventId,
        ts: message.created_at,
        project: find(id)!.project,
        spec: id,
        type: "spec_message_posted",
        agent: message.author,
        host: "demo",
        data: {
          message_id: message.id,
          preview: message.body.slice(0, 160),
          ...(message.question ? { question: true } : {}),
        },
      });
      return ok({ message });
    },

    async reviewDetail(reviewId) {
      if (reviewId !== "rev-1") {
        return {
          ok: false,
          error: { status: 404, code: "review_not_found", message: `No review '${reviewId}'` },
        };
      }
      return ok({
        review: {
          id: "rev-1",
          spec_id: "chorus-rate-limits",
          iteration: 1,
          status: "pending_decision",
          created_at: "2026-07-01T12:00:00Z",
          stages: [],
        },
        findings: [
          {
            id: "f-1",
            severity: "HIGH" as const,
            category: "correctness",
            file: "src/api/limits.ts",
            line_start: 42,
            line_end: 48,
            title: "Race in token-bucket refill",
            description:
              "Two concurrent refills can double-credit the bucket; clamp inside the lock.",
            confidence: 0.9,
            resolution: "OPEN" as const,
          },
          {
            id: "f-2",
            severity: "LOW" as const,
            category: "simplification",
            file: "src/api/limits.ts",
            line_start: 80,
            line_end: 80,
            title: "Duplicated window math",
            description: "The same window arithmetic appears in three branches; extract a helper.",
            confidence: 0.7,
            resolution: "DISMISSED" as const,
          },
        ],
      });
    },

    async approveReview(reviewId) {
      return ok({ review_id: reviewId, approved: true });
    },

    async dismissFinding(_reviewId, findingId) {
      return ok({ finding_id: findingId, dismissed: true });
    },

    async recentEvents(limit = 100) {
      const page = events.slice(-limit);
      return ok({ limit, returned: page.length, events: page });
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
