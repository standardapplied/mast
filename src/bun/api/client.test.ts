import { afterAll, describe, expect, test } from "bun:test";
import { native } from "../../../test/setup";
import { SailClient } from "./client";
import { SailConflictError, SailHttp, type HttpDeps } from "./http";
import { RateLimiter } from "./rate-limiter";

const { Response, fetch } = native;

/**
 * Integration tests against a faithful in-process mock of the control plane
 * (real HTTP via Bun.serve): schema_version envelopes, quoted-updated_at
 * ETags, If-Match → 412 precondition_failed, the error envelope, and 429
 * retry. No sleeps — the retry scheduler fires immediately.
 */

const SPEC = {
  id: "mast-api-client",
  project: "sail-mast",
  title: "Typed client",
  status: "in_progress",
  priority: 0,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
};

let specBody = "# original";
let rateLimitHits = 0;

function envelope(payload: Record<string, unknown>): Response {
  return Response.json({ schema_version: 1, ...payload });
}

function apiError(status: number, code: string, message: string, action?: string): Response {
  return Response.json({ schema_version: 1, error: { code, message, action } }, { status });
}

const ETAG = `"${SPEC.updated_at}"`;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("Authorization");
    if (auth !== "Bearer sess_test") {
      return apiError(auth ? 403 : 401, auth ? "invalid_bearer_token" : "missing_bearer_token", "no");
    }

    if (url.pathname === "/v1/specs" && req.method === "GET") {
      const status = url.searchParams.get("status");
      const specs = status && status !== SPEC.status ? [] : [SPEC];
      return envelope({ specs, total: specs.length });
    }
    if (url.pathname === "/v1/specs/board") {
      return envelope({
        draft: 1,
        pending: 0,
        in_progress: 1,
        review: 0,
        done: 2,
        archived: 0,
        next_ready_id: "mast-terminal",
        done_open_findings: 0,
      });
    }
    if (url.pathname === `/v1/specs/${SPEC.id}` && req.method === "GET") {
      return new Response(JSON.stringify({ schema_version: 1, spec: SPEC, body: specBody }), {
        headers: { "Content-Type": "application/json", ETag: ETAG },
      });
    }
    if (url.pathname === `/v1/specs/${SPEC.id}/content`) {
      if (req.method === "GET") return envelope({ spec_id: SPEC.id, body: specBody, plan: "" });
      const ifMatch = req.headers.get("If-Match");
      if (ifMatch && ifMatch !== "*" && ifMatch !== ETAG) {
        return apiError(
          412,
          "precondition_failed",
          `Spec '${SPEC.id}' was modified by another writer.`,
          "Re-GET the spec, replay your changes against the fresh ETag, then retry.",
        );
      }
      return req.json().then((body) => {
        specBody = (body as { body: string }).body;
        return envelope({ spec_id: SPEC.id, body: specBody, plan: "" });
      });
    }
    if (url.pathname === "/v1/projects/chorus/dispatch" && req.method === "POST") {
      // Faithful to the control plane: only snake_case spec_id selects a spec;
      // anything else falls back to auto-pick, which here has nothing ready.
      return req.json().then((body) =>
        (body as { spec_id?: string }).spec_id === SPEC.id
          ? envelope({
              name: "chorus",
              dispatched: true,
              reason: "",
              branch_created: true,
              spec: { ...SPEC, repos: ["api"], reasoning_effort: "high", model: "m", agent: "claude-code", branch: "agent/x" },
            })
          : envelope({ name: "chorus", dispatched: false, reason: "no_pending_specs", branch_created: false }),
      );
    }
    if (url.pathname === "/v1/rate-limited-once") {
      rateLimitHits++;
      if (rateLimitHits === 1) return apiError(429, "rate_limited", "Rate limit exceeded.");
      return envelope({ ok: true });
    }
    return apiError(404, "not_found", `No route ${url.pathname}`);
  },
});

afterAll(() => server.stop(true));

function makeClient(token = "sess_test") {
  const deps: HttpDeps = {
    fetchFn: fetch,
    limiter: new RateLimiter(600, 60_000),
    schedule: (fn) => void fn(),
  };
  const base = `http://localhost:${server.port}`;
  const http = new SailHttp({ server: base, loginOrigin: base, token }, deps);
  return { client: new SailClient(http), http };
}

describe("SailClient against a mock control plane", () => {
  test("lists specs and reads the board", async () => {
    const { client } = makeClient();
    const list = await client.listSpecs({ status: "in_progress" });
    expect(list.data.total).toBe(1);
    expect(list.data.specs[0]?.id).toBe("mast-api-client");

    const board = await client.board("sail-mast");
    expect(board.data.done).toBe(2);
    expect(board.data.next_ready_id).toBe("mast-terminal");
  });

  test("captures the ETag on GET and round-trips content with If-Match", async () => {
    const { client } = makeClient();
    const detail = await client.getSpec(SPEC.id);
    expect(detail.etag).toBe(`"${SPEC.updated_at}"`);

    const updated = await client.putSpecContent(SPEC.id, { body: "# new body" }, detail.etag);
    expect(updated.data.body).toBe("# new body");
    expect((await client.getSpecContent(SPEC.id)).data.body).toBe("# new body");
  });

  test("a stale If-Match surfaces a typed 412 conflict", async () => {
    const { client } = makeClient();
    const stale = client.putSpecContent(SPEC.id, { body: "# clobber" }, '"2020-01-01T00:00:00Z"');
    const error = await stale.catch((e) => e);
    expect(error).toBeInstanceOf(SailConflictError);
    expect(error.status).toBe(412);
    expect(error.code).toBe("precondition_failed");
    expect(error.action).toContain("fresh ETag");
  });

  test("dispatches the chosen spec via the snake_case wire key", async () => {
    const { client } = makeClient();
    const result = await client.dispatch("chorus", { spec_id: SPEC.id, mode: "background" });
    expect(result.data.dispatched).toBe(true);
    expect(result.data.branch_created).toBe(true);
  });

  test("maps the error envelope to a typed error", async () => {
    const { client } = makeClient();
    const error = await client.getProject("nope").catch((e) => e);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
  });

  test("401/403 for missing and bad tokens", async () => {
    const missing = await makeClient(null as unknown as string).client.board().catch((e) => e);
    expect(missing.status).toBe(401);
    expect(missing.code).toBe("missing_bearer_token");

    const bad = await makeClient("wrong").client.board().catch((e) => e);
    expect(bad.status).toBe(403);
  });

  test("retries a 429 with backoff and succeeds", async () => {
    const { http } = makeClient();
    const result = await http.request<{ ok: boolean }>("GET", "/v1/rate-limited-once");
    expect(result.data.ok).toBe(true);
    expect(rateLimitHits).toBe(2);
  });
});
