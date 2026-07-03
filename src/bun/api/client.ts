import type {
  AgentReportResponse,
  AgentStatusView,
  DispatchRequest,
  DispatchResponse,
  FindingDismissResponse,
  GlobalBoardResponse,
  GlobalSpecContentResponse,
  GlobalSpecDetailResponse,
  GlobalSpecHistoryResponse,
  GlobalSpecsListResponse,
  ProjectResponse,
  RecentEventsResponse,
  WhoAmI,
  ReviewApproveResponse,
  ReviewDetailResponse,
  ReviewListResponse,
  SailEvent,
  SessionListResponse,
  SpecContentRequest,
  SpecCreateRequest,
  SpecFilter,
  SpecUpdateRequest,
} from "../../shared/sail-models";
import type { ApiResult, SailHttp } from "./http";

/**
 * Typed client for the Sail control-plane REST surface. Spec reads return the
 * response ETag (the quoted updated_at) so writers can send If-Match and get a
 * typed 412 conflict instead of a silent overwrite.
 */
export class SailClient {
  constructor(private readonly http: SailHttp) {}

  listSpecs(filter: SpecFilter = {}): Promise<ApiResult<GlobalSpecsListResponse>> {
    return this.http.request("GET", "/v1/specs", { query: filter });
  }

  board(project?: string): Promise<ApiResult<GlobalBoardResponse>> {
    return this.http.request("GET", "/v1/specs/board", { query: { project } });
  }

  getSpec(id: string): Promise<ApiResult<GlobalSpecDetailResponse>> {
    return this.http.request("GET", `/v1/specs/${id}`);
  }

  createSpec(request: SpecCreateRequest): Promise<ApiResult<GlobalSpecDetailResponse>> {
    return this.http.request("POST", "/v1/specs", { body: request });
  }

  updateSpec(
    id: string,
    request: SpecUpdateRequest,
    ifMatch?: string,
  ): Promise<ApiResult<GlobalSpecDetailResponse>> {
    return this.http.request("PUT", `/v1/specs/${id}`, { body: request, ifMatch });
  }

  deleteSpec(id: string, ifMatch?: string): Promise<ApiResult<{ id: string; deleted: boolean }>> {
    return this.http.request("DELETE", `/v1/specs/${id}`, { ifMatch });
  }

  getSpecContent(id: string): Promise<ApiResult<GlobalSpecContentResponse>> {
    return this.http.request("GET", `/v1/specs/${id}/content`);
  }

  putSpecContent(
    id: string,
    content: SpecContentRequest,
    ifMatch?: string,
  ): Promise<ApiResult<GlobalSpecContentResponse>> {
    return this.http.request("PUT", `/v1/specs/${id}/content`, { body: content, ifMatch });
  }

  specReviews(id: string): Promise<ApiResult<ReviewListResponse>> {
    return this.http.request("GET", `/v1/specs/${id}/reviews`);
  }

  specHistory(id: string): Promise<ApiResult<GlobalSpecHistoryResponse>> {
    return this.http.request("GET", `/v1/specs/${id}/history`);
  }

  restoreSpec(id: string, rev: number): Promise<ApiResult<GlobalSpecDetailResponse>> {
    return this.http.request("POST", `/v1/specs/${id}/restore`, { body: { rev } });
  }

  getProject(project: string): Promise<ApiResult<ProjectResponse>> {
    return this.http.request("GET", `/v1/projects/${project}`);
  }

  dispatch(project: string, request: DispatchRequest): Promise<ApiResult<DispatchResponse>> {
    return this.http.request("POST", `/v1/projects/${project}/dispatch`, { body: request });
  }

  agentStatus(project: string): Promise<ApiResult<AgentStatusView>> {
    return this.http.request("GET", `/v1/projects/${project}/agent`);
  }

  agentLog(project: string, tail: number): Promise<ApiResult<{ log: string }>> {
    return this.http.request("GET", `/v1/projects/${project}/agent/log`, { query: { tail } });
  }

  agentSessions(project: string): Promise<ApiResult<SessionListResponse>> {
    return this.http.request("GET", `/v1/projects/${project}/agent/sessions`);
  }

  stopAgent(project: string): Promise<ApiResult<AgentStatusView>> {
    return this.http.request("POST", `/v1/projects/${project}/agent/stop`);
  }

  agentReport(project: string): Promise<ApiResult<AgentReportResponse>> {
    return this.http.request("GET", `/v1/projects/${project}/agent/report`);
  }

  getReview(reviewId: string): Promise<ApiResult<ReviewDetailResponse>> {
    return this.http.request("GET", `/v1/reviews/${reviewId}`);
  }

  approveReview(reviewId: string): Promise<ApiResult<ReviewApproveResponse>> {
    return this.http.request("POST", `/v1/reviews/${reviewId}/approve`);
  }

  dismissFinding(reviewId: string, findingId: string): Promise<ApiResult<FindingDismissResponse>> {
    return this.http.request("POST", `/v1/reviews/${reviewId}/dismiss/${findingId}`);
  }

  whoami(): Promise<ApiResult<WhoAmI>> {
    return this.http.request("GET", "/v1/whoami");
  }

  recentEvents(limit?: number): Promise<ApiResult<RecentEventsResponse>> {
    return this.http.request("GET", "/v1/events/recent", { query: { limit } });
  }

  eventStats(): Promise<ApiResult<Record<string, unknown>>> {
    return this.http.request("GET", "/v1/events/stats");
  }

  publishEvent(event: Omit<SailEvent, "v" | "id">): Promise<ApiResult<{ id: number; event: SailEvent }>> {
    return this.http.request("POST", "/v1/events", { body: { v: 1, ...event } });
  }
}
