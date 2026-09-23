import { useEffect, useRef, useState } from "react";
import type { GlobalSpecView, PruneReport } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import { Checkbox } from "../components/Checkbox";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { humanBytes } from "../tauri/transfers";
import { catalogStore, connectCatalog } from "./catalogStore";
import { refusalDetail } from "./snapshots";

/** Whether the server's prune rule would call `me` the spec's owner: its
 *  assignee, or its creator while it is unassigned. A default, not a gate —
 *  the server decides. */
export function ownedBy(spec: GlobalSpecView, me: string | undefined): boolean {
  if (!me) return false;
  return spec.assignee ? spec.assignee === me : spec.created_by === me;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function list(parts: string[]): string {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * What a prune takes, as one sentence in the voice of the other confirms:
 * what goes, where, and what it frees — only what is there, never a zero.
 * `subject` names the one spec pruned; several are counted instead.
 */
export function pruneSummary(report: PruneReport, subject?: string): string {
  const single = subject !== undefined && report.specs <= 1;
  const parts = [
    single ? subject : count(report.specs, "spec"),
    ...(report.rooms > 0 ? [single && report.rooms === 1 ? "its room" : count(report.rooms, "room")] : []),
    ...(report.messages > 0 ? [count(report.messages, "message")] : []),
    ...(report.runs > 0 ? [count(report.runs, "run")] : []),
    ...(report.reviews > 0 ? [count(report.reviews, "review")] : []),
  ];
  const freed = report.blob_bytes > 0 ? ` — ${humanBytes(report.blob_bytes)} freed` : "";
  return `Erases ${list(parts)} from every box, history included${freed}. This can’t be undone.`;
}

/**
 * Prune, report first. The server rehearses the erasure — the dry run is the
 * erasure itself, rolled back — and the dialog says what goes in one sentence
 * before Prune can erase, exactly once. Offered more than one spec, it lists
 * them to choose from, the caller's own checked. Every refusal renders here
 * verbatim and the dialog stays open; an erase whose answer never came back
 * says its outcome is unknown.
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

  const single = candidates.length === 1 ? candidates[0]!.id : undefined;
  const named = ids.length === 1 ? ids[0]! : count(ids.length, "spec");

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
          ? `The prune’s outcome is unknown (${detail}); the board rechecks these specs.`
          : `Prune refused: ${detail}`,
      );
      return;
    }
    onPruned(
      result.value.requested
        ? `Asked main to prune ${named}; it goes on this box’s next sync.`
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
      title={single ? `Prune ${single}?` : "Prune archived specs?"}
      size={single ? "sm" : "md"}
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
            {busy ? "Pruning…" : single || ids.length < 2 ? "Prune" : `Prune ${named}`}
          </Button>
        </>
      }
    >
      <div className="prune-body">
        {!single && (
          <div className="prune-choices" data-testid="prune-choices">
            {candidates.map((spec) => (
              <div key={spec.id} className="prune-choice" data-testid={`prune-choice-${spec.id}`}>
                <Checkbox
                  checked={chosen.has(spec.id)}
                  disabled={busy}
                  onChange={() => toggle(spec.id)}
                  label={<span className="prune-choice-id">{spec.id}</span>}
                />
                <span className="prune-choice-owner">{spec.assignee ?? spec.created_by ?? ""}</span>
              </div>
            ))}
          </div>
        )}
        {refusal ? (
          <p className="dispatch-block" data-testid="prune-refused">
            {refusalDetail(refusal)}
          </p>
        ) : (
          <p className="meta-value" data-testid="prune-report">
            {!selection
              ? "Choose the specs to prune."
              : report
                ? pruneSummary(report, ids.length === 1 ? ids[0] : undefined)
                : "Counting what goes…"}
          </p>
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
