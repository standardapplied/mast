import { useState } from "react";
import type { GlobalSpecView } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { unmetDependencies } from "./useBoard";

/**
 * Dispatch confirmation: shows the agent/model/branch the launch will use and
 * the real dispatch — role-gated for non-admins, readiness-gated for blocked
 * specs. Dispatch always runs the agent in the background (autonomous in the
 * container); there is no terminal here.
 */
export function DispatchDialog({
  gateway,
  spec,
  allSpecs,
  canDispatch,
  roleKnown,
  onClose,
  onResult,
}: {
  gateway: Gateway;
  spec: GlobalSpecView;
  allSpecs: GlobalSpecView[];
  canDispatch: boolean;
  roleKnown: boolean;
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  const unmet = unmetDependencies(spec, allSpecs);
  const blocked = unmet.length > 0;
  const notPending = spec.status !== "pending";
  const runnable = !blocked && !notPending && canDispatch;

  const run = async () => {
    setBusy(true);
    const result = await gateway.dispatch(spec.project, { specId: spec.id, mode: "background" });
    setBusy(false);
    if (!result.ok) {
      const forbidden = result.error.status === 403;
      onResult(
        forbidden
          ? `Dispatch needs admin role — ${result.error.message}`
          : `Dispatch failed: ${result.error.message}`,
        false,
      );
      onClose();
      return;
    }
    if (result.value.dispatched) {
      onResult(`Dispatched ${spec.id}${result.value.branch_created ? " · branch created" : ""}.`, true);
    } else {
      onResult(`Could not dispatch ${spec.id}: ${result.value.reason || "not ready"}.`, false);
    }
    onClose();
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={`Dispatch ${spec.id}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!runnable || busy} onClick={() => void run()} data-testid="dispatch-go">
            {busy ? "Dispatching…" : "Dispatch"}
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

        {blocked && (
          <p className="dispatch-block" data-testid="dispatch-blocked">
            Blocked — waiting on {unmet.join(", ")}. Resolve dependencies first.
          </p>
        )}
        {notPending && !blocked && (
          <p className="dispatch-block">Only pending specs can be dispatched (this is {spec.status}).</p>
        )}
        {roleKnown && !canDispatch && !blocked && !notPending && (
          <p className="dispatch-block" data-testid="dispatch-role">
            Dispatch requires the admin role. Your credential can’t launch agents.
          </p>
        )}
      </div>
    </Dialog>
  );
}
