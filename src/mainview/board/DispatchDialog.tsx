import { useEffect, useState } from "react";
import type { GlobalSpecView } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { catalogStore, connectCatalog } from "./catalogStore";
import { unmetDependencies } from "./useBoard";

/**
 * Dispatch confirmation: shows the agent/model/branch the launch will use and
 * the real dispatch — gated locally only for read-only credentials (any write
 * credential may attempt; the server's assignee-or-admin policy decides and
 * its refusal is rendered verbatim), readiness-gated for blocked specs.
 * Dispatch always runs the agent in the background (autonomous in the
 * container); there is no terminal here.
 *
 * Restart mode re-dispatches a review/done spec: the server atomically resets
 * it to pending and relaunches on its prior branch, so the pending-only gate
 * doesn't apply — the dependency and role gates still do.
 */
export function DispatchDialog({
  gateway,
  spec,
  allSpecs,
  depsKnown,
  canDispatch,
  roleKnown,
  restart = false,
  onClose,
  onResult,
}: {
  gateway: Gateway;
  spec: GlobalSpecView;
  allSpecs: GlobalSpecView[];
  /** False while the spec list is still loading — readiness is unknown, so the
   *  dialog holds a quiet checking state instead of flashing Blocked → Ready. */
  depsKnown: boolean;
  canDispatch: boolean;
  roleKnown: boolean;
  restart?: boolean;
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => connectCatalog(gateway), [gateway]);

  const unmet = depsKnown ? unmetDependencies(spec, allSpecs) : [];
  const blocked = depsKnown && unmet.length > 0;
  const notPending = !restart && spec.status !== "pending";
  const runnable = depsKnown && !blocked && !notPending && canDispatch;

  // busy stays true through onClose — the dialog unmounts in the Dispatching…
  // state rather than flashing back to an actionable one for a frame.
  const run = async () => {
    setBusy(true);
    const result = await catalogStore.dispatch(spec.project, {
      spec_id: spec.id,
      mode: "background",
      ...(restart ? { restart: true } : {}),
    });
    if (!result.ok) {
      // The server's resource policy is the authority and its refusals name
      // the exact remedy (wrong assignee, wrong node, read-only credential) —
      // render them verbatim instead of guessing at a blanket cause.
      const forbidden = result.error.status === 403;
      const detail = `${result.error.message}${result.error.action ? ` — ${result.error.action}` : ""}`;
      onResult(forbidden ? `Dispatch refused: ${detail}` : `Dispatch failed: ${detail}`, false);
      onClose();
      return;
    }
    if (result.value.dispatched) {
      onResult(
        result.value.restarted
          ? `Re-dispatched ${spec.id} (was ${spec.status}).`
          : `Dispatched ${spec.id}${result.value.branch_created ? " · branch created" : ""}.`,
        true,
      );
    } else {
      onResult(`Could not dispatch ${spec.id}: ${result.value.reason || "not ready"}.`, false);
    }
    onClose();
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={`${restart ? "Re-dispatch" : "Dispatch"} ${spec.id}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!runnable || busy} onClick={() => void run()} data-testid="dispatch-go">
            {busy ? "Dispatching…" : restart ? "Re-dispatch" : "Dispatch"}
          </Button>
        </>
      }
    >
      <div className="dispatch-body">
        <p className="dispatch-summary">{spec.title}</p>

        <div className="dispatch-facts">
          <div className="prop">
            <span className="prop-label">Project</span>
            <span className="prop-value">{spec.project}</span>
          </div>
          <div className="prop">
            <span className="prop-label">Agent</span>
            <span className="prop-value">{spec.agent ?? "project default"}</span>
          </div>
          <div className="prop">
            <span className="prop-label">Model</span>
            <span className="prop-value">{spec.model ?? "—"}</span>
          </div>
          <div className="prop">
            <span className="prop-label">Assignee</span>
            <span className="prop-value">{spec.assignee ?? "—"}</span>
          </div>
        </div>

        {restart && (
          <p className="dispatch-summary" data-testid="dispatch-restart-note">
            Re-dispatch resets {spec.id} to pending and relaunches on its prior branch.
          </p>
        )}

        {!depsKnown && (
          <p className="dispatch-block" data-testid="dispatch-checking">
            Checking dependencies…
          </p>
        )}
        {blocked && (
          <p className="dispatch-block" data-testid="dispatch-blocked">
            Blocked — waiting on {unmet.join(", ")}. Resolve dependencies first.
          </p>
        )}
        {depsKnown && notPending && !blocked && (
          <p className="dispatch-block">Only pending specs can be dispatched (this is {spec.status}).</p>
        )}
        {depsKnown && roleKnown && !canDispatch && !blocked && !notPending && (
          <p className="dispatch-block" data-testid="dispatch-role">
            Your credential is read-only — launching agents needs write access.
          </p>
        )}
      </div>
    </Dialog>
  );
}
