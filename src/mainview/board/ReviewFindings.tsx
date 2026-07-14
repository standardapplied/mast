import { useEffect, useState } from "react";
import type { Finding, ReviewView } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Badge, Button, type BadgeTone } from "../components/ui";
import type { Gateway } from "../gateway";

/**
 * Read-only dialog over one review's findings (GET /v1/reviews/{id}): what the
 * reviewer flagged, where, and how it was resolved. Deciding a finding's fate
 * (dismiss/approve) stays with the review workflow; this pane only shows it.
 */

const SEVERITY_TONE: Record<Finding["severity"], BadgeTone> = {
  CRITICAL: "error",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

/** "src/api/limits.ts:42–48", collapsing a single-line range to one number. */
export function findingLocation(finding: Finding): string | undefined {
  if (!finding.file) return undefined;
  if (finding.line_start <= 0) return finding.file;
  const range =
    finding.line_end > finding.line_start
      ? `${finding.line_start}–${finding.line_end}`
      : `${finding.line_start}`;
  return `${finding.file}:${range}`;
}

type Load = { findings: Finding[] | null; error: string | null };

export function ReviewFindings({
  gateway,
  review,
  onClose,
}: {
  gateway: Gateway;
  review: ReviewView;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ findings: null, error: null });

  useEffect(() => {
    let alive = true;
    void gateway.reviewDetail(review.id).then((result) => {
      if (!alive) return;
      setLoad(
        result.ok
          ? { findings: result.value.findings, error: null }
          : { findings: null, error: result.error.message },
      );
    });
    return () => {
      alive = false;
    };
  }, [gateway, review.id]);

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={`Review #${review.iteration} · ${review.status}`}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {load.error && <p className="connect-error">Couldn’t load the findings: {load.error}</p>}
      {!load.error && load.findings === null && <p className="meta-value">Loading findings…</p>}
      {load.findings?.length === 0 && (
        <p className="meta-value">No findings — a clean review.</p>
      )}
      {load.findings?.map((finding) => (
        <div key={finding.id} className="finding-row" data-testid={`finding-${finding.id}`}>
          <div className="finding-head">
            <Badge tone={SEVERITY_TONE[finding.severity]}>
              {finding.severity.toLowerCase()}
            </Badge>
            <span className="finding-title">{finding.title}</span>
            {finding.resolution !== "OPEN" && (
              <span className="eyebrow finding-resolution">
                {finding.resolution.toLowerCase()}
              </span>
            )}
          </div>
          <span className="finding-meta">
            {finding.category}
            {findingLocation(finding) ? ` · ${findingLocation(finding)}` : ""}
          </span>
          <p className="finding-desc">{finding.description}</p>
          {finding.suggestion?.rationale && (
            <p className="finding-suggestion">{finding.suggestion.rationale}</p>
          )}
        </div>
      ))}
    </Dialog>
  );
}
