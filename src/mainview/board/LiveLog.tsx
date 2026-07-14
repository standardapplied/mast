import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentLogRole } from "../../shared/sail-models";
import { Checkbox } from "../components/Checkbox";
import { Cross } from "../components/icons";
import { ToggleButton } from "../components/ToggleButton";
import { Badge } from "../components/ui";
import type { Gateway } from "../gateway";
import { useAgentLog, type AgentLogView } from "./useAgentLog";

/**
 * A read-only drawer that follows an in-progress spec's agent output live — the
 * desktop equivalent of `sail agent log --follow` (and `--review`). It streams,
 * autoscrolls (with a jump-to-latest once you scroll up), renders claude-code's
 * stream-json to readable lines (raw toggle for the unprocessed stream), and
 * shows a read-only status header. It never stops, steers, or intervenes.
 */

const ROLE_OPTIONS = [
  { value: "build", label: "Build" },
  { value: "review", label: "Review" },
];

const STATE_LABEL: Record<AgentLogView["state"], string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  disconnected: "Off",
};

const STATE_DOT: Record<AgentLogView["state"], string> = {
  connecting: "connecting",
  connected: "connected",
  reconnecting: "connecting",
  disconnected: "off",
};

function formatElapsed(startedAt: string | undefined, now: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

type Session = { label: string; tone: "accent" | "success" | "warning" | "neutral"; detail?: string };

function session(view: AgentLogView): Session {
  if (view.lifecycle?.type === "agent_failed") {
    return { label: "Failed", tone: "warning", detail: view.lifecycle.detail };
  }
  if (view.lifecycle?.type === "spec_stranded") {
    return { label: "Stranded", tone: "warning", detail: view.lifecycle.detail };
  }
  if (view.status?.agent_running) return { label: "Running", tone: "accent" };
  if (view.status) return { label: "Idle", tone: "neutral" };
  return { label: "—", tone: "neutral" };
}

export function LiveLog({
  gateway,
  project,
  specId,
  initialRole = "build",
  onClose,
}: {
  gateway: Gateway;
  project: string;
  specId: string;
  /** Which log to open on first render — "review" for a spec in review. */
  initialRole?: AgentLogRole;
  onClose: () => void;
}) {
  const view = useAgentLog(gateway, project, specId, initialRole);
  const { role, setRole, raw, setRaw, lines, state, status } = view;

  const bodyRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => lines.filter((line) => raw || line.rendered !== ""), [lines, raw]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [shown, pinned]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const jump = () => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setPinned(true);
    }
  };

  const sess = session(view);
  const elapsed = status?.agent_running ? formatElapsed(status.started_at, now) : null;
  const runningElsewhere =
    status?.agent_running && status.branch ? !status.branch.includes(specId) : false;

  return (
    <div className="live-log-scrim" onClick={onClose} data-testid="live-log">
      <aside className="live-log" onClick={(e) => e.stopPropagation()} aria-label={`Agent log for ${specId}`}>
        <header className="live-log__head">
          <div className="live-log__title">
            <span className="eyebrow">Agent log</span>
            <span className="live-log__spec">{specId}</span>
          </div>
          <span className="terminal-pane__conn live-log__conn" data-state={STATE_DOT[state]}>
            <span className="terminal-pane__dot" />
            {STATE_LABEL[state]}
          </span>
          <button type="button" className="live-log__close" onClick={onClose} aria-label="Close agent log">
            <Cross size={16} />
          </button>
        </header>

        <div className="live-log__status" data-testid="live-log-status">
          <Badge tone={sess.tone}>{sess.label}</Badge>
          {elapsed && <span className="live-log__meta">{elapsed}</span>}
          {status?.branch && <span className="live-log__meta">{status.branch}</span>}
          {sess.detail && <span className="live-log__detail">{sess.detail}</span>}
          {runningElsewhere && (
            <span className="live-log__warn" data-testid="live-log-elsewhere">
              container is running a different spec
            </span>
          )}
        </div>

        <div className="live-log__controls">
          <ToggleButton
            options={ROLE_OPTIONS}
            value={role}
            onChange={(v) => setRole(v as AgentLogRole)}
          />
          <label className="live-log__raw">
            <Checkbox checked={raw} onChange={setRaw} label="Raw" />
          </label>
        </div>

        <div className="live-log__body" ref={bodyRef} onScroll={onScroll} data-testid="live-log-body">
          {shown.length === 0 ? (
            <p className="live-log__empty">
              {view.error ? `Couldn’t load the ${role} log: ${view.error}` : "Waiting for output…"}
            </p>
          ) : (
            shown.map((line) => (
              <div key={line.key} className="live-log__line">
                {raw ? line.raw : line.rendered}
              </div>
            ))
          )}
        </div>

        {!pinned && (
          <button type="button" className="live-log__jump" onClick={jump} data-testid="live-log-jump">
            Jump to latest ↓
          </button>
        )}
      </aside>
    </div>
  );
}
