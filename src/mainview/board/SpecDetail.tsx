import { useCallback, useEffect, useState } from "react";
import type {
  GlobalSpecDetailResponse,
  GlobalSpecView,
  ReviewView,
  SpecRevisionView,
  SpecUpdateRequest,
} from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Input } from "../components/Input";
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
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SpecUpdateRequest>({});
  const [restoring, setRestoring] = useState<number | null>(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    const [detail, content, history, reviews, all] = await Promise.all([
      gateway.getSpec(specId),
      gateway.getSpecContent(specId),
      gateway.specHistory(specId),
      gateway.specReviews(specId),
      gateway.listSpecs({}),
    ]);
    if (!detail.ok) {
      setError(detail.error.message);
      return;
    }
    setError(null);
    setLoaded({
      detail: detail.value,
      etag: detail.etag,
      body: content.ok ? content.value.body : (detail.value.body ?? ""),
      plan: content.ok ? content.value.plan : "",
      history: history.ok ? history.value.revisions : [],
      reviews: reviews.ok ? reviews.value.reviews : [],
      allSpecs: all.ok ? all.value.specs : [],
    });
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

  if (error) {
    return (
      <div className="detail">
        <p className="board-error">{error}</p>
        <Button variant="ghost" onClick={onBack}>
          Back to board
        </Button>
      </div>
    );
  }
  if (!loaded) return <div className="detail detail-loading">Loading…</div>;

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
        <div className="detail-heading">
          <Eyebrow>{spec.project}</Eyebrow>
          <h1 className="detail-title">{spec.id}</h1>
          <p className="detail-subtitle">{spec.title}</p>
        </div>
        <div className="detail-header-actions">
          <Badge tone={spec.status === "in_progress" ? "accent" : spec.status === "review" ? "warning" : spec.status === "done" ? "success" : "neutral"}>
            {STATUS_LABEL[spec.status]}
          </Badge>
          <Button variant="ghost" onClick={onBack}>
            Board
          </Button>
        </div>
      </div>

      <div className="prop-bar">
        {propItem("Assignee", "assignee", spec.assignee ?? "")}
        {propItem("Agent", "agent", spec.agent ?? "")}
        {propItem("Model", "model", spec.model ?? "")}
        <div className="prop">
          <span className="prop-label">Priority</span>
          {editing ? (
            <Input
              className="prop-input"
              type="number"
              defaultValue={String(spec.priority)}
              onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) }))}
            />
          ) : (
            <span className="prop-value">{spec.priority}</span>
          )}
        </div>
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
          <Card title="Dependencies">
            <div className="dep-section">
              <span className="eyebrow">Depends on</span>
              <div className="dep-chips">
                {(spec.depends_on ?? []).length === 0 && <span className="meta-value">—</span>}
                {(spec.depends_on ?? []).map((id) => (
                  <DepChip key={id} id={id} unmet={unmet.includes(id)} onOpen={onOpenSpec} />
                ))}
              </div>
              <span className="eyebrow">Blocked by this</span>
              <div className="dep-chips">
                {dependents.length === 0 && <span className="meta-value">—</span>}
                {dependents.map((s) => (
                  <DepChip key={s.id} id={s.id} unmet={false} onOpen={onOpenSpec} />
                ))}
              </div>
            </div>
          </Card>

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
