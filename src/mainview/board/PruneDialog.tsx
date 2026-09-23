import { useEffect, useRef, useState } from "react";
import type { GlobalSpecView, PruneReport } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { humanBytes } from "../tauri/transfers";
import { catalogStore, connectCatalog } from "./catalogStore";
import { refusalDetail } from "./snapshots";

const COUNTS: ReadonlyArray<[keyof PruneReport, string]> = [
  ["specs", "Specs"],
  ["rooms", "Rooms"],
  ["messages", "Messages"],
  ["runs", "Runs"],
  ["reviews", "Reviews"],
  ["events", "Events"],
];

/** Whether the server's prune rule would call `me` the spec's owner: its
 *  assignee, or its creator while it is unassigned. A default, not a gate —
 *  the server decides. */
export function ownedBy(spec: GlobalSpecView, me: string | undefined): boolean {
  if (!me) return false;
  return spec.assignee ? spec.assignee === me : spec.created_by === me;
}

/**
 * Prune, report first. The server rehearses the erasure of the chosen specs —
 * the dry run is the erasure itself, rolled back — and the counts and freed
 * content show before Prune everywhere can erase, exactly once. Offered more
 * than one spec, the dialog lists them to choose from, the caller's own
 * checked. Every refusal renders here verbatim and the dialog stays open; an
 * erase whose answer never came back says its outcome is unknown.
 */
export function PruneDialog({
  gateway,
  candidates,
  selected,
  onClose,
  onPruned,
}: {
  gateway: Gateway;
  candidates: readonly GlobalSpecView[];
  selected: readonly string[];
  onClose: () => void;
  onPruned: (message: string, requested: boolean) => void;
}) {
  const [chosen, setChosen] = useState(() => new Set(selected));
  const [report, setReport] = useState<PruneReport | null>(null);
  const [refusal, setRefusal] = useState<SailWireError | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => connectCatalog(gateway), [gateway]);

  const ids = candidates.map((spec) => spec.id).filter((id) => chosen.has(id));
  const selection = ids.join("\n");
  useEffect(() => {
    setReport(null);
    setRefusal(null);
    setFailure(null);
    if (!selection) return;
    let live = true;
    void catalogStore.pruneSpecs({ ids: selection.split("\n"), dry_run: true }).then((result) => {
      if (!live) return;
      if (result.ok) setReport(result.value);
      else setRefusal(result.error);
    });
    return () => {
      live = false;
    };
  }, [selection]);

  const named = ids.length === 1 ? ids[0] : `${ids.length} specs`;

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const prune = async () => {
    if (inFlight.current || !report) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await catalogStore.pruneSpecs({ ids, dry_run: false });
    inFlight.current = false;
    setBusy(false);
    if (!result.ok) {
      const detail = refusalDetail(result.error);
      setFailure(
        result.error.status === 0 || result.error.status >= 500
          ? `The prune's outcome is unknown (${detail}); the board rechecks these specs.`
          : `Prune refused: ${detail}`,
      );
      return;
    }
    onPruned(
      result.value.requested
        ? `Asked main to prune ${named}; it goes on this box's next sync.`
        : `Pruned ${named} everywhere.`,
      result.value.requested,
    );
    onClose();
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      onBeforeClose={() => !inFlight.current}
      title={candidates.length === 1 ? `Prune ${candidates[0]!.id}?` : "Prune archived specs?"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            className="btn-danger"
            disabled={!report || busy}
            onClick={() => void prune()}
            data-testid="prune-go"
          >
            {busy ? "Pruning…" : ids.length > 1 ? `Prune ${named} everywhere` : "Prune everywhere"}
          </Button>
        </>
      }
    >
      <div className="dispatch-body">
        {candidates.length > 1 && (
          <div className="prune-choices" data-testid="prune-choices">
            {candidates.map((spec) => (
              <label key={spec.id} className="prune-choice">
                <input
                  type="checkbox"
                  checked={chosen.has(spec.id)}
                  disabled={busy}
                  onChange={() => toggle(spec.id)}
                  data-testid={`prune-choice-${spec.id}`}
                />
                <span className="prune-choice-id">{spec.id}</span>
                <span className="prune-choice-owner">{spec.assignee ?? spec.created_by ?? ""}</span>
              </label>
            ))}
          </div>
        )}
        {!selection && (
          <p className="dispatch-summary" data-testid="prune-empty">
            Choose the specs to prune.
          </p>
        )}
        {selection && !report && !refusal && (
          <p className="dispatch-summary" data-testid="prune-counting">
            Counting what goes…
          </p>
        )}
        {refusal && (
          <p className="dispatch-block" data-testid="prune-refused">
            {refusalDetail(refusal)}
          </p>
        )}
        {report && (
          <>
            <div className="dispatch-facts" data-testid="prune-report">
              {COUNTS.map(([key, label]) => (
                <div className="prop" key={key}>
                  <span className="prop-label">{label}</span>
                  <span className="prop-value">{String(report[key])}</span>
                </div>
              ))}
              <div className="prop">
                <span className="prop-label">Content freed</span>
                <span className="prop-value">{humanBytes(report.blob_bytes)}</span>
              </div>
            </div>
            <p className="dispatch-block">
              Erased on every box with its history, for good. This cannot be undone.
            </p>
          </>
        )}
        {failure && (
          <p className="dispatch-block" data-testid="prune-failed">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
