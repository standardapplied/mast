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

export type DispatchRequest = {
  specId?: string;
  mode?: string;
  dryRun?: boolean;
  repos?: string[];
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

export type WhoAmI = {
  fde?: string;
  name: string;
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
