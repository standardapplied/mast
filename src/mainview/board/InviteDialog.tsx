import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentView, GlobalSpecView, SailEvent } from "../../shared/sail-models";
import { Dialog } from "../components/Dialog";
import { Spinner } from "../components/icons";
import { Input } from "../components/Input";
import { Select, type SelectOption } from "../components/Select";
import { ToggleButton } from "../components/ToggleButton";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { mapInviteOutcome } from "./inviteOutcome";

/**
 * Invite an agent into this spec's room: agent, optional model, and the one
 * checkbox — Full unchecked is read only. The server declares each agent's
 * mode support (GET /v1/agents) and this dialog renders exactly that: an
 * unsupported combination is greyed with the server's reason, never a guessed
 * one. Refusals on submit (a build holding the repos, a mode the agent lacks,
 * a policy refusal) render inline, verbatim, with the dialog held open. When
 * the agents endpoint is unavailable (an older sail), the agent field falls
 * back to free text and the server rules on submit.
 *
 * A full invite snapshots the container first, and on the dir backend that is a
 * slow full copy — the server accepts the invite immediately (202) and does the
 * snapshot off the request thread, so the call cannot time out or be force-killed
 * mid-copy. The dialog then shows a snapshot-in-progress state and settles when
 * the room's `snapshot_created` event lands for this run: success closes with a
 * toast, an `error` on the event renders inline. A read-only invite pays no
 * snapshot, so it settles on the 202 as before.
 */
export function InviteDialog({
  gateway,
  spec,
  canDispatch,
  roleKnown,
  onClose,
  onResult,
}: {
  gateway: Gateway;
  spec: GlobalSpecView;
  canDispatch: boolean;
  roleKnown: boolean;
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}) {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [agentsUnavailable, setAgentsUnavailable] = useState(false);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [full, setFull] = useState(false);
  const [skipSnapshot, setSkipSnapshot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pendingRef = useRef<{ runId: string; label: string; agent: string } | null>(null);
  const bufferRef = useRef<SailEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    void gateway.listAgents().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setAgentsUnavailable(true);
        return;
      }
      setAgents(result.value.agents);
      const firstSupported = result.value.agents.find((candidate) =>
        candidate.modes.some((m) => m.mode === "read_only" && m.supported),
      );
      setAgent((current) => current || (firstSupported ?? result.value.agents[0])?.name || "");
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const modeOf = (candidate: AgentView) =>
    candidate.modes.find((m) => m.mode === (full ? "full" : "read_only"));

  const options: SelectOption[] = (agents ?? []).map((candidate) => {
    const mode = modeOf(candidate);
    const supported = mode?.supported !== false;
    return {
      value: candidate.name,
      label: candidate.display_name,
      disabled: !supported,
      ...(supported ? {} : { description: mode?.reason }),
    };
  });

  const selected = (agents ?? []).find((candidate) => candidate.name === agent);
  const selectedUnsupported = selected !== undefined && modeOf(selected)?.supported === false;
  const runnable = agent.trim() !== "" && !selectedUnsupported && canDispatch && !busy;

  const settle = useCallback(
    (event: SailEvent) => {
      const pending = pendingRef.current;
      if (!pending) return;
      if (event.type !== "snapshot_created" || event.data?.run_id !== pending.runId) return;
      pendingRef.current = null;
      const error = event.data?.error;
      if (error) {
        setRefusal(String(error));
        setSnapshotting(false);
        setBusy(false);
        return;
      }
      onResult(
        `Invited ${pending.agent} (full access) into ${spec.id} — snapshot ${pending.label} taken, the agent is launching.`,
        true,
      );
      onClose();
    },
    [onClose, onResult, spec.id],
  );

  useEffect(() => {
    const unsubscribe = gateway.onEvent((event) => {
      if (event.type !== "snapshot_created") return;
      if (pendingRef.current) settle(event);
      else bufferRef.current.push(event);
    });
    return unsubscribe;
  }, [gateway, settle]);

  const run = async () => {
    setBusy(true);
    setRefusal(null);
    const chosen = agent.trim();
    const result = await gateway.invite(spec.id, {
      agent: chosen,
      ...(model.trim() ? { model: model.trim() } : {}),
      full,
      ...(full && skipSnapshot ? { snapshot: false } : {}),
    });
    const outcome = mapInviteOutcome(result, spec.id, chosen);
    if (outcome.kind === "refused") {
      setRefusal(outcome.detail);
      setBusy(false);
      return;
    }
    if (!result.ok || !result.value.snapshot) {
      onResult(outcome.message, true);
      onClose();
      return;
    }
    pendingRef.current = { runId: result.value.run_id, label: result.value.snapshot, agent: chosen };
    setSnapshotting(true);
    const buffered = bufferRef.current;
    bufferRef.current = [];
    for (const event of buffered) {
      if (!pendingRef.current) break;
      settle(event);
    }
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={`Invite an agent into ${spec.id}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {snapshotting ? "Close" : "Cancel"}
          </Button>
          {!snapshotting && (
            <Button disabled={!runnable} onClick={() => void run()} data-testid="invite-go">
              {busy ? "Inviting…" : "Invite"}
            </Button>
          )}
        </>
      }
    >
      {snapshotting ? (
        <div className="dispatch-body" data-testid="invite-snapshotting">
          <div className="invite-progress">
            <Spinner size={18} />
            <div>
              <p className="dispatch-summary">Snapshotting the container…</p>
              <p className="dispatch-hint">
                On the default storage this is a full copy and can take a few minutes on a large
                workspace. You can close this — the agent joins the room the moment the snapshot
                completes.
              </p>
            </div>
          </div>
          {refusal && (
            <p className="dispatch-block" data-testid="invite-refusal">
              {refusal}
            </p>
          )}
        </div>
      ) : (
        <div className="dispatch-body">
        <p className="dispatch-summary">
          A second perspective in this room: chat and critique read only, or grant Full access to
          let it draft specs and change code.
        </p>

        {agentsUnavailable ? (
          <Input
            label="Agent"
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            placeholder="claude-code or codex"
            data-testid="invite-agent-input"
          />
        ) : (
          <Select
            label="Agent"
            value={agent}
            onChange={(value) => setAgent(value)}
            options={options}
            placeholder="Choose an agent"
          />
        )}

        <Input
          label="Model (optional)"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="agent default"
          data-testid="invite-model"
        />

        <div className="field">
          <span className="field-label">Access</span>
          <ToggleButton
            value={full ? "full" : "read_only"}
            onChange={(value) => setFull(value === "full")}
            options={[
              { value: "read_only", label: "Read only" },
              { value: "full", label: "Full" },
            ]}
          />
        </div>

        {full && (
          <div className="field" data-testid="invite-snapshot-field">
            <span className="field-label">Snapshot</span>
            <ToggleButton
              value={skipSnapshot ? "skip" : "snapshot"}
              onChange={(value) => setSkipSnapshot(value === "skip")}
              options={[
                { value: "snapshot", label: "Snapshot first" },
                { value: "skip", label: "Skip" },
              ]}
            />
            <p className="dispatch-hint">
              {skipSnapshot
                ? "Launches immediately with no rollback point — undo any damage by hand."
                : "A pre-launch rollback point. On the default storage this is a slow full copy."}
            </p>
          </div>
        )}

        {selectedUnsupported && (
          <p className="dispatch-block" data-testid="invite-unsupported">
            {modeOf(selected)?.reason}
          </p>
        )}
        {roleKnown && !canDispatch && (
          <p className="dispatch-block" data-testid="invite-role">
            Your credential is read-only — inviting agents needs write access.
          </p>
        )}
        {refusal && (
          <p className="dispatch-block" data-testid="invite-refusal">
            {refusal}
          </p>
        )}
        </div>
      )}
    </Dialog>
  );
}
