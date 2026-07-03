import { useState } from "react";
import type { DispatchResponse, GlobalSpecView } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { ToggleButton } from "../components/ToggleButton";
import { Badge, Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { unmetDependencies } from "./useBoard";

const MODE_OPTIONS = [
  { value: "background", label: "Background" },
  { value: "foreground", label: "Foreground" },
];

/**
 * Dispatch confirmation: shows the agent/model/branch the launch will use, the
 * target mode, a dry-run preview (plan without launching), and the real
 * dispatch — role-gated for non-admins, readiness-gated for blocked specs.
 * Dispatch is a control-plane action; there is no terminal here.
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
  const [mode, setMode] = useState("background");
  const [busy, setBusy] = useState<"dry" | "go" | null>(null);
  const [preview, setPreview] = useState<DispatchResponse | null>(null);

  const unmet = unmetDependencies(spec, allSpecs);
  const blocked = unmet.length > 0;
  const notPending = spec.status !== "pending";
  const runnable = !blocked && !notPending && canDispatch;

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "dry" : "go");
    const result = await gateway.dispatch(spec.project, { specId: spec.id, mode, dryRun });
    setBusy(null);
    if (!result.ok) {
      const forbidden = result.error.status === 403;
      onResult(
        forbidden
          ? `Dispatch needs admin role — ${result.error.message}`
          : `Dispatch failed: ${result.error.message}`,
        false,
      );
      if (!dryRun) onClose();
      return;
    }
    if (dryRun) {
      setPreview(result.value);
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
          <Button variant="ghost" disabled={!runnable || busy !== null} onClick={() => void run(true)}>
            {busy === "dry" ? "Checking…" : "Dry run"}
          </Button>
          <Button disabled={!runnable || busy !== null} onClick={() => void run(false)} data-testid="dispatch-go">
            {busy === "go" ? "Dispatching…" : "Dispatch"}
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

        <div className="dispatch-mode">
          <span className="prop-label">Mode</span>
          <ToggleButton className="toggle-sm" options={MODE_OPTIONS} value={mode} onChange={setMode} />
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

        {preview && (
          <div className="dispatch-preview" data-testid="dispatch-preview">
            <span className="eyebrow">Dry run</span>
            <div className="dispatch-facts">
              <div className="prop">
                <span className="prop-label">Would dispatch</span>
                <span className="prop-value">
                  <Badge tone={preview.dispatched ? "success" : "warning"}>
                    {preview.dispatched ? "Ready" : preview.reason || "No"}
                  </Badge>
                </span>
              </div>
              {preview.spec?.branch && (
                <div className="prop">
                  <span className="prop-label">Branch</span>
                  <span className="prop-value">{preview.spec.branch}</span>
                </div>
              )}
              {preview.snapshot && (
                <div className="prop">
                  <span className="prop-label">Snapshot</span>
                  <span className="prop-value">{preview.snapshot}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
