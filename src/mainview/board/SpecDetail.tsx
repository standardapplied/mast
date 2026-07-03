import { useCallback, useEffect, useState } from "react";
import type {
  GlobalSpecDetailResponse,
  GlobalSpecView,
  ReviewView,
  SpecRevisionView,
  SpecUpdateRequest,
} from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import { Dialog } from "../components/Dialog";
import { CaretLeft, Info } from "../components/icons";
import { Input } from "../components/Input";
import { LoadingMark } from "../components/Loading";
import { NumberStepper } from "../components/NumberStepper";
import { Tooltip } from "../components/Tooltip";
import { useToast } from "../components/Toast";
import { Badge, Button, Card, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { Markdown } from "../markdown";
import { STATUS_LABEL } from "./lifecycle";
import { dependentsOf, unmetDependencies } from "./useBoard";

type Loaded = {
  detail: GlobalSpecDetailResponse;
  etag?: string;
  body: string;
  plan: string;
  history: SpecRevisionView[];
  reviews: ReviewView[];
  allSpecs: GlobalSpecView[];
};

function DepChip({ id, unmet, onOpen }: { id: string; unmet: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className={unmet ? "dep-chip is-unmet" : "dep-chip"}
      onClick={() => onOpen(id)}
    >
      {id}
    </button>
  );
}

export function SpecDetail({
  gateway,
  specId,
  onOpenSpec,
  onBack,
}: {
  gateway: Gateway;
  specId: string;
  onOpenSpec: (id: string) => void;
  onBack: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<SailWireError | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SpecUpdateRequest>({});
  const [restoring, setRestoring] = useState<number | null>(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    // Core first — just what the page needs to render — so the detail appears
    // after two calls and a bridge timeout on enrichment never blocks it.
    const [detail, content] = await Promise.all([
      gateway.getSpec(specId),
      gateway.getSpecContent(specId),
    ]);
    if (!detail.ok) {
      setError(detail.error);
      return;
    }
    setError(null);
    setLoaded({
      detail: detail.value,
      etag: detail.etag,
      body: content.ok ? content.value.body : (detail.value.body ?? ""),
      plan: content.ok ? content.value.plan : "",
      history: [],
      reviews: [],
      allSpecs: [],
    });

    // Enrichment — history, reviews, dependency graph — is non-fatal and
    // merged in as it arrives; a failure here leaves the page usable.
    const [history, reviews, all] = await Promise.all([
      gateway.specHistory(specId),
      gateway.specReviews(specId),
      gateway.listSpecs({}),
    ]);
    setLoaded((prev) =>
      prev
        ? {
            ...prev,
            history: history.ok ? history.value.revisions : prev.history,
            reviews: reviews.ok ? reviews.value.reviews : prev.reviews,
            allSpecs: all.ok ? all.value.specs : prev.allSpecs,
          }
        : prev,
    );
  }, [gateway, specId]);

  useEffect(() => {
    setLoaded(null);
    setEditing(false);
    void load();
  }, [load]);

  useEffect(
    () =>
      gateway.onEvent((event) => {
        if (event.spec === specId) void load();
      }),
    [gateway, specId, load],
  );

  // A lost-contact (status 0) error retries in the background, like the board.
  useEffect(() => {
    if (error?.status !== 0) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [error, load]);

  if (error) {
    const lostContact = error.status === 0;
    return (
      <div className="detail">
        <div className="detail-heading-row">
          <button type="button" className="back-btn" onClick={onBack} aria-label="Back to board">
            <CaretLeft size={16} />
          </button>
          <div className="detail-heading">
            <Eyebrow>{specId}</Eyebrow>
            <p className="detail-subtitle">
              {lostContact
                ? "Lost contact with the control plane — retrying…"
                : `${error.message}${error.action ? ` — ${error.action}` : ""}`}
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="detail">
        <LoadingMark label={specId} />
      </div>
    );
  }

  const spec = loaded.detail.spec;
  const unmet = unmetDependencies(spec, loaded.allSpecs);
  const dependents = dependentsOf(loaded.allSpecs, spec.id);

  const saveMeta = async () => {
    const result = await gateway.updateSpec(spec.id, draft, loaded.etag);
    if (result.ok) {
      setEditing(false);
      setDraft({});
      void load();
      showToast("success", `${spec.id} updated.`);
    } else if (result.error.status === 412) {
      showToast("error", `${spec.id} was changed by someone else — reloaded, replay your edit.`);
      void load();
    } else {
      showToast("error", result.error.message);
    }
  };

  const restore = async (rev: number) => {
    setRestoring(null);
    const result = await gateway.restoreSpec(spec.id, rev);
    if (result.ok) {
      showToast("success", `${spec.id} restored to rev ${rev}.`);
      void load();
    } else {
      showToast("error", result.error.message);
    }
  };

  const propItem = (label: string, key: keyof SpecUpdateRequest, value: string) => (
    <div className="prop">
      <span className="prop-label">{label}</span>
      {editing ? (
        <Input
          className="prop-input"
          defaultValue={value}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        />
      ) : (
        <span className="prop-value">{value || "—"}</span>
      )}
    </div>
  );

  return (
    <div className="detail">
      <div className="detail-header">
        <div className="detail-heading-row">
          <button
            type="button"
            className="back-btn"
            onClick={onBack}
            aria-label="Back to board"
            data-testid="back-to-board"
          >
            <CaretLeft size={16} />
          </button>
          <div className="detail-heading">
            <Eyebrow>{spec.project}</Eyebrow>
            <h1 className="detail-title">{spec.id}</h1>
            <p className="detail-subtitle">{spec.title}</p>
          </div>
        </div>
        <div className="detail-header-actions">
          <Badge tone={spec.status === "in_progress" ? "accent" : spec.status === "review" ? "warning" : spec.status === "done" ? "success" : "neutral"}>
            {STATUS_LABEL[spec.status]}
          </Badge>
        </div>
      </div>

      <div className="prop-bar">
        {propItem("Assignee", "assignee", spec.assignee ?? "")}
        {propItem("Agent", "agent", spec.agent ?? "")}
        {propItem("Model", "model", spec.model ?? "")}
        <div className="prop">
          <span className="prop-label prop-label-hint">
            Priority
            <Tooltip content="Higher number = higher priority. Dispatch picks the highest-priority ready spec first.">
              <span className="prop-hint-icon" tabIndex={0}>
                <Info size={13} />
              </span>
            </Tooltip>
          </span>
          {editing ? (
            <NumberStepper
              value={draft.priority ?? spec.priority}
              min={0}
              max={100}
              step={10}
              onChange={(priority) => setDraft((d) => ({ ...d, priority }))}
            />
          ) : (
            <span className="prop-value">{spec.priority}</span>
          )}
        </div>
        <div className="prop">
          <span className="prop-label">Repos</span>
          {editing ? (
            <Input
              className="prop-input"
              defaultValue={(spec.repos ?? []).join(", ")}
              placeholder="api, web"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  repos: e.target.value.split(",").map((r) => r.trim()).filter(Boolean),
                }))
              }
            />
          ) : (
            <span className="prop-value">{(spec.repos ?? []).join(", ") || "—"}</span>
          )}
        </div>
        {editing && (
          <div className="prop">
            <span className="prop-label">Depends on</span>
            <Input
              className="prop-input prop-input-wide"
              defaultValue={(spec.depends_on ?? []).join(", ")}
              placeholder="spec-a, spec-b"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  depends_on: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                }))
              }
            />
          </div>
        )}
        <div className="prop">
          <span className="prop-label">Branch</span>
          <span className="prop-value">{spec.branch ?? "—"}</span>
        </div>
        <div className="prop">
          <span className="prop-label">Updated</span>
          <span className="prop-value">
            {spec.updated_at.slice(0, 16).replace("T", " ")}
            {spec.updated_by ? ` · ${spec.updated_by}` : ""}
          </span>
        </div>
        <div className="prop-actions">
          {editing ? (
            <>
              <Button onClick={() => void saveMeta()}>Save</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft({});
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </div>

      {unmet.length > 0 && (
        <p className="detail-blocked" data-testid="blocked-banner">
          Blocked — waiting on{" "}
          {unmet.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <DepChip id={id} unmet onOpen={onOpenSpec} />
            </span>
          ))}
        </p>
      )}

      <div className="detail-grid">
        <div className="detail-main">
          <Card>
            <Markdown source={loaded.body || "*No body yet.*"} />
          </Card>
          {loaded.plan && (
            <Card title="Plan">
              <Markdown source={loaded.plan} />
            </Card>
          )}
        </div>

        <div className="detail-side">
          {((spec.depends_on ?? []).length > 0 || dependents.length > 0) && (
            <Card title="Dependencies">
              <div className="dep-section">
                {(spec.depends_on ?? []).length > 0 && (
                  <>
                    <span className="eyebrow">Depends on</span>
                    <div className="dep-chips">
                      {(spec.depends_on ?? []).map((id) => (
                        <DepChip key={id} id={id} unmet={unmet.includes(id)} onOpen={onOpenSpec} />
                      ))}
                    </div>
                  </>
                )}
                {dependents.length > 0 && (
                  <>
                    <span className="eyebrow">Blocked by this</span>
                    <div className="dep-chips">
                      {dependents.map((s) => (
                        <DepChip key={s.id} id={s.id} unmet={false} onOpen={onOpenSpec} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Card>
          )}

          <Card title="Reviews">
            {loaded.reviews.length === 0 && <span className="meta-value">No reviews yet.</span>}
            {loaded.reviews.map((review) => (
              <div key={review.id} className="review-row">
                <span className="meta-value">
                  #{review.iteration} · {review.status}
                </span>
                <span className="eyebrow">
                  {review.stages.reduce((n, s) => n + s.finding_count, 0)} findings
                </span>
              </div>
            ))}
          </Card>

          <Card title="History">
            {loaded.history.map((revision) => (
              <div key={revision.rev} className="history-row">
                <span className="meta-value">
                  rev {revision.rev} · {revision.origin} {revision.actor ? `· ${revision.actor}` : ""}
                </span>
                <button type="button" className="dep-chip" onClick={() => setRestoring(revision.rev)}>
                  Restore
                </button>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <Dialog
        isOpen={restoring !== null}
        onClose={() => setRestoring(null)}
        title={`Restore rev ${restoring}?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoring(null)}>
              Cancel
            </Button>
            <Button onClick={() => restoring !== null && void restore(restoring)}>Restore</Button>
          </>
        }
      >
        <p className="meta-value">
          The spec body and metadata return to revision {restoring}. The current state stays in
          history.
        </p>
      </Dialog>
    </div>
  );
}
