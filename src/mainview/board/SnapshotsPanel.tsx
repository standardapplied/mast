import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapshotView } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Badge, Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { relativeTime } from "./rooms";
import {
  refusalDetail,
  snapshotEventOutcome,
  sortNewestFirst,
  sourceTone,
  type SnapshotMutation,
} from "./snapshots";

/**
 * The per-project snapshots panel: the list with source badges and ages,
 * delete behind a confirm, restore behind a consequence-naming confirm.
 * Mutations are accepted asynchronously by the server, so a row registers its
 * in-progress state before the request leaves — the server publishes completion
 * from an independent worker, and a fast snapshot_restored / snapshot_deleted
 * event must find the pending mutation even when it outruns the 202 response.
 * A refused request clears that optimistic state (unless an event already
 * resolved it) and renders the server's refusal verbatim.
 */

type Confirm = { action: "restore" | "delete"; name: string };

export function SnapshotsPanel({
  gateway,
  project,
  onClose,
}: {
  gateway: Gateway;
  project: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<SnapshotView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<SnapshotMutation | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const pendingRef = useRef<SnapshotMutation | null>(null);
  pendingRef.current = pending;

  const refresh = useCallback(async () => {
    const result = await gateway.listSnapshots(project);
    if (result.ok) {
      setRows(sortNewestFirst(result.value.snapshots));
      setLoadError(null);
    } else {
      setLoadError(refusalDetail(result.error));
    }
  }, [gateway, project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return gateway.onEvent((event) => {
      const outcome = snapshotEventOutcome(event, project, pendingRef.current);
      if (!outcome) return;
      if (outcome.kind === "resolved") {
        pendingRef.current = null;
        setPending(null);
        if (outcome.error) {
          setRefusal(outcome.error);
        } else {
          setNotice(
            outcome.action === "restore"
              ? `Restored '${outcome.name}'.`
              : `Deleted '${outcome.name}'.`,
          );
        }
      }
      void refresh();
    });
  }, [gateway, project, refresh]);

  const mutate = async (request: Confirm) => {
    setConfirm(null);
    setRefusal(null);
    setNotice(null);
    const mutation: SnapshotMutation = { name: request.name, action: request.action };
    pendingRef.current = mutation;
    setPending(mutation);
    const result =
      request.action === "restore"
        ? await gateway.restoreSnapshot(project, request.name)
        : await gateway.deleteSnapshot(project, request.name);
    if (!result.ok && pendingRef.current === mutation) {
      pendingRef.current = null;
      setPending(null);
      setRefusal(refusalDetail(result.error));
    }
  };

  return (
    <Dialog isOpen onClose={onClose} title={`Snapshots — ${project}`} size="md">
      <div className="snapshots-panel" data-testid="snapshots-panel">
        {refusal && (
          <p className="dispatch-block" data-testid="snapshot-refusal">
            {refusal}
          </p>
        )}
        {notice && <p data-testid="snapshot-notice">{notice}</p>}
        {loadError && (
          <p className="dispatch-block" data-testid="snapshot-load-error">
            {loadError}
          </p>
        )}
        {rows === null && !loadError && <p>Loading…</p>}
        {rows?.length === 0 && <p>No snapshots yet.</p>}
        {rows?.map((snapshot) => {
          const busy = pending?.name === snapshot.name;
          return (
            <div
              key={snapshot.name}
              className="history-row"
              data-testid={`snapshot-${snapshot.name}`}
            >
              <span className="meta-value">{snapshot.name}</span>
              <Badge tone={sourceTone(snapshot.source)}>{snapshot.source}</Badge>
              <time dateTime={snapshot.created_at}>
                {relativeTime(snapshot.created_at, Date.now())}
              </time>
              {busy ? (
                <span data-testid="snapshot-busy">
                  {pending?.action === "restore" ? "restoring…" : "deleting…"}
                </span>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() => setConfirm({ action: "restore", name: snapshot.name })}
                  >
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    className="btn-ghost-danger"
                    disabled={pending !== null}
                    onClick={() => setConfirm({ action: "delete", name: snapshot.name })}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          );
        })}
        {confirm && (
          <div className="dispatch-block" data-testid={`confirm-${confirm.action}`}>
            <p>
              {confirm.action === "restore"
                ? `Restore '${confirm.name}'? The container's current state — files, services, and ` +
                  "anything an agent changed since — is discarded and replaced by this " +
                  "snapshot. This cannot be undone."
                : `Delete snapshot '${confirm.name}'? This cannot be undone.`}
            </p>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button className="btn-danger" onClick={() => void mutate(confirm)}>
              {confirm.action === "restore" ? "Restore" : "Delete"}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
