import { useEffect, useState } from "react";
import type { PruneReport } from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { humanBytes } from "../tauri/transfers";
import { catalogStore, connectCatalog } from "./catalogStore";

const COUNTS: ReadonlyArray<[keyof PruneReport, string]> = [
  ["specs", "Specs"],
  ["rooms", "Rooms"],
  ["messages", "Messages"],
  ["runs", "Runs"],
  ["reviews", "Reviews"],
  ["events", "Events"],
];

/**
 * Prune, report first. Opening asks the server what pruning `ids` would erase
 * — the dry run is the erasure itself, rolled back — and shows the counts and
 * the content freed; only then does Prune everywhere erase, exactly once. A
 * refusal (not the owner, read-only, an old server) is rendered verbatim, and
 * a node's prune reports that main erases it on the next sync.
 */
export function PruneDialog({
  gateway,
  ids,
  onClose,
  onResult,
}: {
  gateway: Gateway;
  ids: string[];
  onClose: () => void;
  onResult: (message: string, ok: boolean, requested: boolean) => void;
}) {
  const [report, setReport] = useState<PruneReport | null>(null);
  const [refusal, setRefusal] = useState<SailWireError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => connectCatalog(gateway), [gateway]);

  const selection = ids.join("\n");
  useEffect(() => {
    let live = true;
    void catalogStore
      .pruneSpecs({ ids: selection.split("\n"), dry_run: true })
      .then((result) => {
        if (!live) return;
        if (result.ok) setReport(result.value);
        else setRefusal(result.error);
      });
    return () => {
      live = false;
    };
  }, [selection]);

  const named = ids.length === 1 ? ids[0] : `${ids.length} specs`;

  const prune = async () => {
    setBusy(true);
    const result = await catalogStore.pruneSpecs({ ids, dry_run: false });
    if (!result.ok) {
      const detail = `${result.error.message}${result.error.action ? ` — ${result.error.action}` : ""}`;
      onResult(`Prune refused: ${detail}`, false, false);
    } else if (result.value.requested) {
      onResult(`Asked main to prune ${named}; it goes on this box's next sync.`, true, true);
    } else {
      onResult(`Pruned ${named} everywhere.`, true, false);
    }
    onClose();
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={`Prune ${named}?`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="btn-danger"
            disabled={!report || busy}
            onClick={() => void prune()}
            data-testid="prune-go"
          >
            {busy ? "Pruning…" : "Prune everywhere"}
          </Button>
        </>
      }
    >
      <div className="dispatch-body">
        {!report && !refusal && (
          <p className="dispatch-summary" data-testid="prune-counting">
            Counting what goes…
          </p>
        )}
        {refusal && (
          <p className="dispatch-block" data-testid="prune-refused">
            {refusal.message}
            {refusal.action ? ` — ${refusal.action}` : ""}
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
      </div>
    </Dialog>
  );
}
