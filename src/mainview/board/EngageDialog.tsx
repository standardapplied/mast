import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentView, SailEvent } from "../../shared/sail-models";
import { Checkbox } from "../components/Checkbox";
import { Dialog } from "../components/Dialog";
import { Spinner } from "../components/icons";
import { Input } from "../components/Input";
import { Select, type SelectOption } from "../components/Select";
import { ToggleButton } from "../components/ToggleButton";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import { catalogStore, connectCatalog } from "./catalogStore";

/**
 * Add an agent to this room: it joins the conversation and answers every
 * human message until removed. Full access is the default — conversations produce
 * artifacts (diagrams, drafts, files). A rollback snapshot is opt-in and off by
 * default (a dir-backend snapshot is a slow full copy); when taken, the
 * engagement takes effect only after it completes, so the dialog shows the
 * pending state and settles on `spec_engaged` / `spec_engage_failed`. Read only
 * is the explicit narrow choice, greyed with the server's own reason where the
 * harness cannot enforce it.
 */
export function EngageDialog({
  gateway,
  specId,
  canDispatch,
  roleKnown,
  onClose,
  onResult,
}: {
  gateway: Gateway;
  specId: string;
  canDispatch: boolean;
  roleKnown: boolean;
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}) {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [agentsUnavailable, setAgentsUnavailable] = useState(false);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [snapshot, setSnapshot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pendingRef = useRef<{ agent: string } | null>(null);
  const bufferRef = useRef<SailEvent[]>([]);

  useEffect(() => connectCatalog(gateway), [gateway]);

  useEffect(() => {
    let cancelled = false;
    void gateway.listAgents().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setAgentsUnavailable(true);
        return;
      }
      setAgents(result.value.agents);
      setAgent((current) => current || result.value.agents[0]?.name || "");
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const readOnlyMode = (candidate: AgentView) =>
    candidate.modes.find((m) => m.mode === "read_only");

  const options: SelectOption[] = (agents ?? []).map((candidate) => {
    const supported = !readOnly || readOnlyMode(candidate)?.supported !== false;
    return {
      value: candidate.name,
      label: candidate.display_name,
      disabled: !supported,
      ...(supported ? {} : { description: readOnlyMode(candidate)?.reason }),
    };
  });

  const selected = (agents ?? []).find((candidate) => candidate.name === agent);
  const selectedUnsupported =
    readOnly && selected !== undefined && readOnlyMode(selected)?.supported === false;
  const runnable = agent.trim() !== "" && !selectedUnsupported && canDispatch && !busy;

  const settle = useCallback(
    (event: SailEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.spec !== specId) return;
      if (event.type === "spec_engage_failed") {
        pendingRef.current = null;
        setRefusal(String(event.data?.error ?? "The engage snapshot failed."));
        setSnapshotting(false);
        setBusy(false);
        return;
      }
      if (event.type !== "spec_engaged") return;
      pendingRef.current = null;
      onResult(`${pending.agent} joined ${specId} and now answers every message here.`, true);
      onClose();
    },
    [onClose, onResult, specId],
  );

  useEffect(() => {
    const unsubscribe = gateway.onEvent((event) => {
      if (event.type !== "spec_engaged" && event.type !== "spec_engage_failed") return;
      if (pendingRef.current) settle(event);
      else bufferRef.current.push(event);
    });
    return unsubscribe;
  }, [gateway, settle]);

  const run = async () => {
    setBusy(true);
    setRefusal(null);
    const chosen = agent.trim();
    const result = await catalogStore.engage(specId, {
      agent: chosen,
      mode: readOnly ? "read_only" : "full",
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(!readOnly && snapshot ? { snapshot: true } : {}),
    });
    if (!result.ok) {
      const action = result.error.action ? ` ${result.error.action}` : "";
      setRefusal(`${result.error.message}${action}`);
      setBusy(false);
      return;
    }
    if (!result.value.snapshot) {
      const mode = readOnly ? "read only" : "full access";
      onResult(`${chosen} joined ${specId} (${mode}) and answers every message here.`, true);
      onClose();
      return;
    }
    pendingRef.current = { agent: chosen };
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
      title={`Add an agent to ${specId}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {snapshotting ? "Close" : "Cancel"}
          </Button>
          {!snapshotting && (
            <Button disabled={!runnable} onClick={() => void run()} data-testid="engage-go">
              {busy ? "Adding…" : "Add agent"}
            </Button>
          )}
        </>
      }
    >
      {snapshotting ? (
        <div className="dispatch-body" data-testid="engage-snapshotting">
          <div className="engage-progress">
            <Spinner size={18} />
            <div>
              <p className="dispatch-summary">Snapshotting the container…</p>
              <p className="dispatch-hint">
                Full access takes its rollback point up front. You can close this; the agent
                joins the room the moment the snapshot completes.
              </p>
            </div>
          </div>
          {refusal && (
            <p className="dispatch-block" data-testid="engage-refusal">
              {refusal}
            </p>
          )}
        </div>
      ) : (
        <div className="dispatch-body">
          <p className="dispatch-summary">
            The agent joins this room and answers every message until you remove it: chat,
            drafts, diagrams, code.
          </p>

          {agentsUnavailable ? (
            <Input
              label="Agent"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              placeholder="claude-code or codex"
              data-testid="engage-agent-input"
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
            data-testid="engage-model"
          />

          <div className="field">
            <span className="field-label">Access</span>
            <ToggleButton
              value={readOnly ? "read_only" : "full"}
              onChange={(value) => setReadOnly(value === "read_only")}
              options={[
                { value: "full", label: "Full" },
                { value: "read_only", label: "Read only" },
              ]}
            />
            <p className="dispatch-hint">
              {readOnly
                ? "Harness-enforced: it reads and answers, nothing more."
                : "It can draft specs and work in the workspace."}
            </p>
          </div>

          {!readOnly && (
            <div className="field" data-testid="engage-snapshot-field">
              <Checkbox
                checked={snapshot}
                onChange={setSnapshot}
                label="Snapshot the container first"
              />
              <p className="dispatch-hint">
                {snapshot
                  ? "A rollback point before the agent joins. On the default storage this is a slow full copy."
                  : "The agent joins immediately. There is no rollback point, so undo any damage by hand."}
              </p>
            </div>
          )}

          {selectedUnsupported && (
            <p className="dispatch-block" data-testid="engage-unsupported">
              {readOnlyMode(selected)?.reason}
            </p>
          )}
          {roleKnown && !canDispatch && (
            <p className="dispatch-block" data-testid="engage-role">
              Your credential is read-only. Adding an agent needs write access.
            </p>
          )}
          {refusal && (
            <p className="dispatch-block" data-testid="engage-refusal">
              {refusal}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
