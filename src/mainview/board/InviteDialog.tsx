import { useEffect, useState } from "react";
import type { AgentView, GlobalSpecView } from "../../shared/sail-models";
import { Checkbox } from "../components/Checkbox";
import { Dialog } from "../components/Dialog";
import { Input } from "../components/Input";
import { Select, type SelectOption } from "../components/Select";
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
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

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

  const run = async () => {
    setBusy(true);
    setRefusal(null);
    const result = await gateway.invite(spec.id, {
      agent: agent.trim(),
      ...(model.trim() ? { model: model.trim() } : {}),
      full,
    });
    const outcome = mapInviteOutcome(result, spec.id, agent.trim());
    if (outcome.kind === "refused") {
      setRefusal(outcome.detail);
      setBusy(false);
      return;
    }
    onResult(outcome.message, true);
    onClose();
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
            Cancel
          </Button>
          <Button disabled={!runnable} onClick={() => void run()} data-testid="invite-go">
            {busy ? "Inviting…" : "Invite"}
          </Button>
        </>
      }
    >
      <div className="dispatch-body">
        <p className="dispatch-summary">
          A second perspective in this room: chat and critique read only, or check Full to let it
          draft specs and change code — a container snapshot is taken first.
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

        <Checkbox
          checked={full}
          onChange={setFull}
          label="Full — spec CLI writes and code changes, paid with a pre-launch snapshot"
        />

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
    </Dialog>
  );
}
