import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentLogRole, RunView, SailEvent } from "../../shared/sail-models";
import { renderAgentLine } from "../agentLog";
import type { Gateway } from "../gateway";
import { latestRun, type AgentLogState } from "../tauri/agentLogStream";

/**
 * Follows one spec's live agent log for the desktop panel: an instant
 * `tail -n` snapshot for content while the SSH stream warms up, then the live
 * tail from line 1 (physical line ids, so a drop resumes with `since = lastId+1`
 * and no gaps or dupes — that resume lives in AgentLogStream). The log is
 * resolved by the clicked spec's newest run, never latest-run-in-project, so it
 * can't show a neighbouring spec's output. Each role (build/review) keeps its
 * own buffer and cursor, so toggling and toggling back resumes where it left
 * off. Terminal lifecycle (agent_failed / spec_stranded) rides the SSE bus and
 * surfaces as an informational badge; a terminal stream refusal (run on another
 * FDE's box) lands in `error` instead of an endless reconnect.
 */

const MAX_LINES = 3000;
const SNAPSHOT_TAIL = 200;
const LIFECYCLE_TYPES = new Set(["agent_failed", "spec_stranded"]);
const RESTART_TYPES = new Set(["agent_session_started", "spec_dispatched"]);
const RUN_CHANGE_TYPES = new Set([
  "spec_dispatched",
  "spec_restarted",
  "agent_session_started",
  "agent_session_stopped",
  "agent_session_completed",
  "agent_cancelled",
  "agent_failed",
]);

export type LogLine = { key: number; raw: string; rendered: string };
export type Lifecycle = { type: string; detail?: string };

type RoleBuffer = { lines: LogLine[]; cursor: number | undefined; loaded: boolean };

export type AgentLogView = {
  role: AgentLogRole;
  setRole: (role: AgentLogRole) => void;
  raw: boolean;
  setRaw: (raw: boolean) => void;
  lines: LogLine[];
  state: AgentLogState;
  /** This spec's newest run for the active role — the panel's session header. */
  run: RunView | null;
  lifecycle: Lifecycle | null;
  /** The snapshot's API error, so a failing log surface reads as an error, not
   *  an eternally empty panel. Cleared the moment any line arrives. */
  error: string | null;
};

function lifecycleDetail(event: SailEvent): string | undefined {
  const detail = event.data?.detail;
  if (typeof detail === "string") return detail;
  const status = event.data?.status;
  return typeof status === "string" ? status : undefined;
}

export function useAgentLog(
  gateway: Gateway,
  project: string | undefined,
  specId: string,
  initialRole: AgentLogRole = "build",
): AgentLogView {
  const [role, setRole] = useState<AgentLogRole>(initialRole);
  const [raw, setRaw] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [state, setState] = useState<AgentLogState>("connecting");
  const [runs, setRuns] = useState<RunView[]>([]);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buffers = useRef<Record<AgentLogRole, RoleBuffer>>({
    build: { lines: [], cursor: undefined, loaded: false },
    review: { lines: [], cursor: undefined, loaded: false },
  });
  const keyRef = useRef(0);

  // The header is run-scoped like the log itself: this spec's runs, never the
  // container's current session (which may belong to a sibling spec in the
  // same project). Loaded once and refreshed on run-lifecycle events — badge
  // state is the presence store's job, so there is no status poll.
  const loadRuns = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    loadRuns.current = () =>
      void gateway.listRuns(specId).then((r) => {
        if (alive && r.ok && Array.isArray(r.value.runs)) setRuns(r.value.runs);
      });
    loadRuns.current();
    return () => {
      alive = false;
      loadRuns.current = () => {};
    };
  }, [gateway, specId]);

  const run = useMemo(() => latestRun(runs, role) ?? null, [runs, role]);

  useEffect(() => {
    if (!project) return;
    return gateway.onEvent((event) => {
      if (event.project !== project) return;
      if (LIFECYCLE_TYPES.has(event.type)) {
        setLifecycle({ type: event.type, detail: lifecycleDetail(event) });
      } else if (RESTART_TYPES.has(event.type)) {
        setLifecycle(null);
      }
      if (RUN_CHANGE_TYPES.has(event.type) && (!event.spec || event.spec === specId)) {
        loadRuns.current();
      }
    });
  }, [gateway, project, specId]);

  useEffect(() => {
    if (!project) return;
    const buf = buffers.current[role];
    let alive = true;
    // A role already loaded resumes onto its kept buffer; a fresh role is seeded
    // by the snapshot until the authoritative stream takes over.
    let tookOver = buf.loaded;

    setLines(buf.lines.slice());
    setState("connecting");
    setError(null);

    let flushQueued = false;
    const flush = () => {
      if (flushQueued) return;
      flushQueued = true;
      queueMicrotask(() => {
        flushQueued = false;
        if (alive) setLines(buf.lines.slice());
      });
    };

    if (!buf.loaded) {
      void gateway.agentLogSnapshot(specId, role, SNAPSHOT_TAIL).then((r) => {
        if (!alive || tookOver) return;
        if (!r.ok) {
          setError(r.error.message);
          return;
        }
        buf.lines = r.value.lines.map((text) => ({
          key: ++keyRef.current,
          raw: text,
          rendered: renderAgentLine(text),
        }));
        flush();
      });
    }

    const since = buf.cursor !== undefined ? buf.cursor + 1 : 1;
    const handle = gateway.followAgentLog(specId, role, since);
    const offState = handle.onState((s) => {
      if (alive) setState(s);
    });
    const offError = handle.onError((message) => {
      if (alive) setError(message);
    });
    const offLine = handle.onLine((line) => {
      if (!alive) return;
      setError(null);
      if (!tookOver) {
        tookOver = true;
        buf.lines = [];
      }
      buf.cursor = line.id;
      buf.loaded = true;
      buf.lines.push({ key: ++keyRef.current, raw: line.text, rendered: renderAgentLine(line.text) });
      if (buf.lines.length > MAX_LINES) buf.lines.splice(0, buf.lines.length - MAX_LINES);
      flush();
    });

    return () => {
      alive = false;
      offState();
      offError();
      offLine();
      handle.stop();
    };
  }, [gateway, project, specId, role]);

  const changeRole = useCallback((next: AgentLogRole) => setRole(next), []);
  return { role, setRole: changeRole, raw, setRaw, lines, state, run, lifecycle, error };
}
