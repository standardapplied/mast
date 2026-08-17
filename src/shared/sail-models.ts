/**
 * Wire types for the Sail control-plane API, mirroring the server DTOs
 * (ApiModels.java, Event.java, Finding.java). Keys are snake_case exactly as
 * serialized; fields the server omits when null/empty are optional here.
 * Success envelopes carry `schema_version: 1` alongside the payload keys.
 */

export type SpecStatus =
  | "draft"
  | "pending"
  | "in_progress"
  | "review"
  | "awaiting_merge"
  | "done"
  | "cancelled"
  | "archived";

export type GlobalSpecView = {
  id: string;
  project: string;
  title: string;
  status: SpecStatus;
  assignee?: string;
  agent?: string;
  model?: string;
  branch?: string;
  priority: number;
  depends_on?: string[];
  repos?: string[];
  created_by?: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
  /** max(updated_at, latest room message); absent on pre-0.17.2 servers. */
  last_activity_at?: string;
  /** An agent question awaits a human reply; absent unless true (0.22.1+). */
  needs_reply?: boolean;
  /** The unanswered question's message id, present with needs_reply. */
  question_message_id?: string;
};

export type SpecView = {
  id: string;
  title: string;
  status: SpecStatus;
  assignee: string;
  depends_on: string[];
  repos: string[];
  agent: string;
  model: string;
  reasoning_effort: string;
  branch: string;
  ready: boolean;
  blocked: boolean;
  unmet_dependencies: string[];
};

export type GlobalSpecsListResponse = {
  specs: GlobalSpecView[];
  total: number;
};

export type GlobalSpecDetailResponse = {
  spec: GlobalSpecView;
  body?: string;
  plan?: string;
  open_findings?: number;
};

export type GlobalBoardResponse = {
  draft: number;
  pending: number;
  in_progress: number;
  review: number;
  awaiting_merge: number;
  done: number;
  /** Absent on sail < v0.13.172, which predates the clean-stop lane. */
  cancelled?: number;
  archived: number;
  next_ready_id?: string;
  done_open_findings: number;
};

export type SpecCreateRequest = {
  id: string;
  project?: string;
  title: string;
  status?: SpecStatus;
  assignee?: string;
  agent?: string;
  model?: string;
  reasoning_effort?: string;
  branch?: string;
  priority?: number;
  depends_on?: string[];
  repos?: string[];
  body?: string;
  plan?: string;
};

export type SpecUpdateRequest = Partial<Omit<SpecCreateRequest, "id">> & { force?: boolean };

export type GlobalSpecContentResponse = {
  spec_id: string;
  body: string;
  plan: string;
};

export type SpecContentRequest = {
  body?: string;
  plan?: string;
};

export type SpecRevisionView = {
  rev: number;
  actor?: string;
  recorded_at: string;
  origin: string;
  deleted: boolean;
};

export type GlobalSpecHistoryResponse = {
  spec_id: string;
  revisions: SpecRevisionView[];
  total: number;
};

/** Which log an agent-follow session tails, mirroring the CLI's `--review`. */
export type AgentLogRole = "build" | "review";

/** GET /v1/projects/{p}/agent — the live build session's snapshot status. */
export type AgentStatusResponse = {
  name: string;
  agent_running: boolean;
  pid?: number;
  task?: string;
  started_at?: string;
  branch?: string;
  log_path?: string;
};

/** GET /v1/runs/{id}/log — a `tail -n` slice of the run's raw, unrendered lines. */
export type AgentLogResponse = {
  run_id: string;
  lines: string[];
  error?: string | null;
};

/** A running run's read-time liveness; absent for terminal or never-stamped runs. */
export type RunPresence = "working" | "quiet";

/** One execution of an agent (RunView in ApiModels.java). */
export type RunView = {
  id: string;
  project: string;
  spec_id?: string;
  node: string;
  role: AgentLogRole;
  agent: string;
  branch?: string;
  pid?: number;
  status: string;
  started_at: string;
  completed_at?: string;
  exit_code?: number;
  log_path?: string;
  principal?: string;
  owner?: string;
  /** When the agent last showed progress; absent on pre-0.21.3 servers and unstamped rows. */
  last_activity_at?: string;
  presence?: RunPresence;
};

/**
 * POST /v1/runs/{id}/stop — the clean-stop lane (sail ≥ v0.13.172). `stopped:
 * false` carries a `reason` (no_agent_running, run_not_running, run_not_active);
 * `spec_cancelled` says whether the spec still reached its terminal status.
 */
export type StopRunResponse = {
  run_id: string;
  stopped: boolean;
  reason?: string;
  pid?: number;
  spec_cancelled: boolean;
};

/** One container snapshot; `source` is derived server-side from the name's prefix. */
export type SnapshotView = {
  name: string;
  created_at: string;
  source: string;
};

/** GET /v1/projects/{p}/snapshots — sail ≥ 0.24. */
export type SnapshotListResponse = {
  snapshots: SnapshotView[];
  total: number;
};

/**
 * The 202 receipt for an async snapshot mutation: the mutation completes later
 * and reports through the matching snapshot_restored / snapshot_deleted event.
 */
export type SnapshotActionResponse = {
  project: string;
  name: string;
  action: string;
  status: string;
};

/** GET /v1/runs?project=&spec= — execution history, newest first. */
export type RunListResponse = {
  project?: string;
  spec?: string;
  runs: RunView[];
};

export type AgentConfigView = {
  type: string;
  auto_snapshot: boolean;
  auto_branch: boolean;
  specs_dir: string;
};

export type ProjectResponse = {
  name: string;
  container_status: string;
  agent: AgentConfigView;
};

export type ProjectContainerStatus = "running" | "stopped" | "not_created" | "error";

/**
 * GET /v1/projects — the synced project catalog (main's source of truth)
 * overlaid with this box's local container states. Catalogued projects with no
 * local container surface as `not_created`.
 */
export type ProjectListItem = {
  name: string;
  container_status: ProjectContainerStatus;
};

export type ProjectListResponse = {
  projects: ProjectListItem[];
};

/** POST /v1/projects/{p}/dispatch — the server reads snake_case keys only. */
export type DispatchRequest = {
  spec_id?: string;
  mode?: string;
  dry_run?: boolean;
  repos?: string[];
  /** Reset a review/done spec to pending and relaunch on its prior branch.
   *  Server-enforced: requires an explicit spec_id. */
  restart?: boolean;
};

export type DispatchedSpecView = {
  id: string;
  title: string;
  status: SpecStatus;
  repos: string[];
  agent: string;
  model: string;
  reasoning_effort: string;
  branch: string;
};

export type AgentStatusView = {
  type: string;
  mode: string;
  running: boolean;
  pid?: number;
  task: string;
  started_at: string;
  branch: string;
  log_path: string;
};

export type DispatchResponse = {
  name: string;
  dispatched: boolean;
  reason: string;
  spec?: DispatchedSpecView;
  agent?: AgentStatusView;
  snapshot?: string;
  branch_created: boolean;
  restarted?: boolean;
};

export type AgentReportResponse = {
  name: string;
  session_status: string;
  started_at?: string;
  ended_at?: string;
  duration?: string;
  branch?: string;
  specs: SpecView[];
  commits_since_launch: number;
  last_commit_minutes_ago?: number;
  guardrail_triggered: boolean;
  guardrail_reason?: string;
  guardrail_action?: string;
  rolled_back: boolean;
  rollback_snapshot?: string;
};

export type SessionView = {
  id: string;
  project: string;
  spec_id?: string;
  agent: string;
  branch?: string;
  task?: string;
  pid?: number;
  status: string;
  started_at: string;
  completed_at?: string;
  exit_code?: number;
};

export type SessionListResponse = {
  project: string;
  sessions: SessionView[];
};

export type StageView = {
  id: string;
  name: string;
  stage_type: string;
  status: string;
  reviewer?: string;
  started_at?: string;
  completed_at?: string;
  finding_count: number;
  error?: string;
};

export type ReviewView = {
  id: string;
  spec_id: string;
  iteration: number;
  status: string;
  created_at: string;
  completed_at?: string;
  decided_by?: string;
  superseded_at?: string;
  error?: string;
  stages: StageView[];
};

export type ReviewListResponse = {
  spec_id: string;
  reviews: ReviewView[];
};

/** Finding serializes its enums UPPERCASE (pre-built map bypasses ApiJson). */
export type Finding = {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  category: string;
  file?: string;
  line_start: number;
  line_end: number;
  title: string;
  description: string;
  evidence?: string;
  suggestion?: { before?: string; after?: string; rationale?: string };
  confidence: number;
  resolution: "OPEN" | "FIXED" | "DISMISSED";
};

export type ReviewDetailResponse = {
  review: ReviewView;
  findings: Finding[];
};

export type ReviewApproveResponse = {
  review_id: string;
  approved: boolean;
};

export type FindingDismissResponse = {
  finding_id: string;
  dismissed: boolean;
};

export type SpecMessage = {
  id: string;
  spec_id: string;
  author: string;
  body: string;
  created_at: string;
  reply_to?: string;
  /** Marked as a question needing a reply; absent unless true. */
  question?: boolean;
};

export type SpecMessageListResponse = {
  spec_id: string;
  messages: SpecMessage[];
  total: number;
};

export type SpecMessagePostRequest = {
  body: string;
  reply_to?: string;
  question?: boolean;
};

export type SpecMessagePostResponse = {
  message: SpecMessage;
};

/** Event wire shape (Event.toJsonLine): id present only when > 0. */
export type SailEvent = {
  v: number;
  id?: number;
  ts: string;
  project: string;
  spec?: string;
  type: string;
  agent: string;
  host: string;
  data?: Record<string, unknown>;
};

export type RecentEventsResponse = {
  limit: number;
  returned: number;
  events: SailEvent[];
};

export type EventStreamState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type ConnectionPhase =
  | "probing"
  | "ready"
  | "unauthenticated"
  | "tunnel-connecting"
  | "tunnel-degraded"
  | "no-host"
  | "failed";

/** One truth for the whole connection: reachability, credential, stream. */
export type ConnectionStatus = {
  phase: ConnectionPhase;
  server: string;
  loginOrigin: string;
  tokenPresent: boolean;
  tokenKind: "session" | "api" | "none";
  stream: EventStreamState;
  detail?: string;
};

/**
 * GET /v1/fdes — the org's synced FDE roster (FdeStore), the assignee
 * candidates for a spec.
 */
export type FdeView = {
  handle: string;
  display_name?: string;
  email?: string;
  role: string;
};

export type FdeListResponse = {
  fdes: FdeView[];
};

/** One invite mode an agent does or does not support (GET /v1/agents). */
export type AgentModeView = {
  mode: "read_only" | "full";
  supported: boolean;
  /** The seam-declared reason when unsupported — rendered verbatim, never guessed. */
  reason?: string;
};

/** One installable agent CLI and its invite-mode support (GET /v1/agents). */
export type AgentView = {
  name: string;
  display_name: string;
  modes: AgentModeView[];
};

export type AgentListResponse = {
  agents: AgentView[];
};

/** Body of POST /v1/specs/{id}/invite: the agent to invite and the one mode choice. */
export type InviteRequest = {
  agent: string;
  model?: string;
  full?: boolean;
};

/** Response of POST /v1/specs/{id}/invite: the launched invite run. */
export type InviteResponse = {
  run_id: string;
  principal: string;
  mode: "read_only" | "full";
  /** The pre-launch snapshot label a full invite paid with; empty for read only. */
  snapshot: string;
};

export type WhoAmI = {
  fde?: string;
  name: string;
  display_name?: string;
  email?: string;
  role: "admin" | "member" | "viewer";
  capabilities: string[];
};

export type SpecFilter = {
  project?: string;
  status?: SpecStatus;
  assignee?: string;
  repo?: string;
  q?: string;
};

export type ApiErrorBody = {
  schema_version: number;
  error: {
    code: string;
    message: string;
    action?: string;
    field_errors?: Array<{ field: string; message: string }>;
  };
};
