import { useCallback, useEffect, useState } from "react";
import type { AgentLogRole,
  FdeView,
  GlobalSpecDetailResponse,
  GlobalSpecView,
  RunView,
  SpecRevisionView,
  SpecStatus,
  SpecUpdateRequest,
} from "../../shared/sail-models";
import type { SailWireError } from "../../shared/types";
import { Dialog } from "../components/Dialog";
import { DetailsDrawer } from "../components/DetailsDrawer";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import { CaretDown, CaretLeft, Info } from "../components/icons";
import { Input } from "../components/Input";
import { LoadingMark } from "../components/Loading";
import { NumberStepper } from "../components/NumberStepper";
import { RoomHeader } from "../components/RoomHeader";
import { Select, type SelectOption } from "../components/Select";
import { ToggleButton } from "../components/ToggleButton";
import { Tooltip } from "../components/Tooltip";
import { useToast } from "../components/Toast";
import { Button, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { Markdown } from "../markdown";
import type { RoomTerminalRequest } from "../terminal/roomDeck";
import { DispatchDialog } from "./DispatchDialog";
import { openTerminalMenu, RoomDeckStrip } from "./RoomDeck";
import { EngageDialog } from "./EngageDialog";
import { InviteDialog } from "./InviteDialog";
import { RosterChip } from "./RosterChip";
import { PresenceChip } from "./PresenceChip";
import { LiveLog } from "./LiveLog";
import { SpecRoom } from "./SpecRoom";
import { canLaunchAgents, STATUS_LABEL, statusLabel } from "./lifecycle";
import { mapStopOutcome, noRunningRunMessage, runningBuildRun } from "./stopRun";
import { dependentsOf, logsElsewhere, unmetDependencies } from "./useBoard";

const STATUS_OPTIONS = (Object.keys(STATUS_LABEL) as SpecStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

const DRAWER_WIDTH_KEY = "mast.room.details.width";

function storedDrawerOpen(embedded: boolean): boolean {
  const stored = localStorage.getItem(
    embedded ? "mast.room.details.rooms.open" : "mast.room.details.board.open",
  );
  return stored === null ? !embedded : stored === "true";
}

function storedDrawerWidth(): number {
  const parsed = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
  return Number.isFinite(parsed) && parsed >= 320 && parsed <= 640 ? parsed : 420;
}

/**
 * The assignee choices: Unassigned, then the roster by handle. A current
 * assignee missing from the roster (departed FDE, stale spec) stays selectable
 * so the Select shows the truth instead of a placeholder.
 */
function assigneeOptions(fdes: FdeView[], current: string | undefined): SelectOption[] {
  const options: SelectOption[] = fdes.map((fde) => ({
    value: fde.handle,
    label: fde.handle,
    description: fde.display_name !== fde.handle ? fde.display_name : undefined,
  }));
  if (current && !fdes.some((fde) => fde.handle === current)) {
    options.unshift({ value: current, label: current, description: "not in the FDE roster" });
  }
  return [{ value: "", label: "Unassigned" }, ...options];
}

const EDITOR_PANES = [
  { value: "write", label: "Write" },
  { value: "preview", label: "Preview" },
];

type Loaded = {
  detail: GlobalSpecDetailResponse;
  etag?: string;
  body: string;
  plan: string;
  history: SpecRevisionView[];
  allSpecs: GlobalSpecView[];
  /** True once enrichment has landed at least once. Until then, readiness and
   *  empty-states are unknown — render nothing rather than a wrong guess that
   *  flips a moment later. */
  enriched: boolean;
};

function DepChip({ id, unmet, onOpen }: { id: string; unmet: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className={unmet ? "dep-chip is-unmet" : "dep-chip"}
      onClick={() => onOpen(id)}
    >
      {id}
    </button>
  );
}

export function SpecDetail({
  gateway,
  specId,
  onOpenSpec,
  onBack,
  onOpenTerminal,
  embedded = false,
  eventDebounceMs = 300,
}: {
  gateway: Gateway;
  specId: string;
  onOpenSpec: (id: string) => void;
  onBack: () => void;
  /** Navigate to the room's full-screen terminal route. */
  onOpenTerminal: (request: RoomTerminalRequest) => void;
  embedded?: boolean;
  /** Coalescing window for event-driven reloads; tests pass 0. */
  eventDebounceMs?: number;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<SailWireError | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SpecUpdateRequest>({});
  const [bodyDraft, setBodyDraft] = useState("");
  // Which editor pane is showing on narrow screens (side-by-side on desktop).
  const [editorPane, setEditorPane] = useState<"write" | "preview">("write");
  const [restoring, setRestoring] = useState<number | null>(null);
  const [stopTarget, setStopTarget] = useState<RunView | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [engageOpen, setEngageOpen] = useState(false);
  const [dismissConfirm, setDismissConfirm] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logRole, setLogRole] = useState<AgentLogRole | null>(null);
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(() => storedDrawerOpen(embedded));
  const [drawerWidth, setDrawerWidth] = useState(storedDrawerWidth);
  const [role, setRole] = useState<{
    canDispatch: boolean;
    canWrite: boolean;
    known: boolean;
    fde?: string;
  }>({
    canDispatch: false,
    canWrite: false,
    known: false,
  });
  // The FDE roster backs the assignee select; null (endpoint missing, older
  // server, error) falls back to the free-form input so editing never blocks.
  const [fdes, setFdes] = useState<FdeView[] | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    void gateway.whoami().then((r) => {
      setRole(
        r.ok
          ? {
              canDispatch: canLaunchAgents(r.value.capabilities),
              canWrite: r.value.capabilities.includes("write"),
              known: true,
              fde: r.value.fde,
            }
          : { canDispatch: true, canWrite: true, known: false },
      );
    });
    void gateway.listFdes().then((r) => {
      if (r.ok && Array.isArray(r.value.fdes) && r.value.fdes.length > 0) setFdes(r.value.fdes);
    });
  }, [gateway]);

  const load = useCallback(async () => {
    // Core first — just what the page needs to render — so the detail appears
    // after two calls and a bridge timeout on enrichment never blocks it.
    const [detail, content] = await Promise.all([
      gateway.getSpec(specId),
      gateway.getSpecContent(specId),
    ]);
    if (!detail.ok) {
      setError(detail.error);
      return;
    }
    setError(null);
    // A reload keeps the previous enrichment on screen — blanking history and
    // the dependency graph on every SSE-triggered refresh made the cards flicker.
    setLoaded((prev) => ({
      detail: detail.value,
      etag: detail.etag,
      body: content.ok ? content.value.body : (detail.value.body ?? ""),
      plan: content.ok ? content.value.plan : "",
      history: prev?.history ?? [],
      allSpecs: prev?.allSpecs ?? [],
      enriched: prev?.enriched ?? false,
    }));

    // Enrichment — history and the dependency graph — is non-fatal and
    // merged in as it arrives; a failure here leaves the page usable.
    const [history, all] = await Promise.all([
      gateway.specHistory(specId),
      gateway.listSpecs({}),
    ]);
    setLoaded((prev) =>
      prev
        ? {
            ...prev,
            history: history.ok ? history.value.revisions : prev.history,
            allSpecs: all.ok ? all.value.specs : prev.allSpecs,
            enriched: true,
          }
        : prev,
    );
  }, [gateway, specId]);

  useEffect(() => {
    setLoaded(null);
    setEditing(false);
    void load();
  }, [load]);

  // Dispatch and agent lifecycle fire several events back-to-back; coalesce
  // them into one reload so the page refreshes once, not in a stutter.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = gateway.onEvent((event) => {
      if (event.spec !== specId || event.type === "spec_message_posted") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), eventDebounceMs);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [gateway, specId, load, eventDebounceMs]);

  // A lost-contact (status 0) error retries in the background, like the board.
  useEffect(() => {
    if (error?.status !== 0) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [error, load]);

  if (error) {
    const lostContact = error.status === 0;
    return (
      <div className="detail">
        <div className="detail-heading-row">
          {!embedded && (
            <button type="button" className="back-btn" onClick={onBack} aria-label="Back to board">
              <CaretLeft size={16} />
            </button>
          )}
          <div className="detail-heading">
            <Eyebrow>{specId}</Eyebrow>
            <p className="detail-subtitle">
              {lostContact
                ? "Lost contact with the control plane — retrying…"
                : `${error.message}${error.action ? ` — ${error.action}` : ""}`}
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="detail">
        <LoadingMark label={specId} />
      </div>
    );
  }

  const spec = loaded.detail.spec;
  const unmet = unmetDependencies(spec, loaded.allSpecs);
  const dependents = dependentsOf(loaded.allSpecs, spec.id);
  const logsOwner = logsElsewhere(spec, role.fde);
  const restart =
    spec.status === "review" || spec.status === "done" || spec.status === "cancelled";

  // Stop is run-addressed like log-follow: resolve this spec's newest running
  // build run first, and never fire a blind stop when none is visible here —
  // the run may live on another FDE's box.
  const beginStop = async () => {
    const runs = await gateway.listRuns(spec.id);
    if (!runs.ok) return showToast("error", runs.error.message);
    const run = runningBuildRun(runs.value.runs);
    if (!run) return showToast("error", noRunningRunMessage(spec.id));
    setStopTarget(run);
  };

  const confirmStop = async (run: RunView) => {
    setStopTarget(null);
    const outcome = mapStopOutcome(await gateway.stopRun(run.id), run);
    showToast(outcome.type, outcome.message);
    if (outcome.refresh) void load();
  };

  const setDetailsOpen = (open: boolean) => {
    setDrawerOpen(open);
    localStorage.setItem(
      embedded ? "mast.room.details.rooms.open" : "mast.room.details.board.open",
      String(open),
    );
  };

  const startEdit = () => {
    setBodyDraft(loaded.body);
    setDraft({});
    setEditing(true);
    setDetailsOpen(true);
  };

  const saveError = (err: SailWireError) => {
    if (err.status === 412) {
      showToast("error", `${spec.id} was changed by someone else — reloaded, replay your edit.`);
      void load();
    } else {
      showToast("error", err.message);
    }
  };

  const saveMeta = async () => {
    // Metadata (status/assignee/…) and the body are separate resources on the
    // server — PUT /v1/specs/{id} ignores the body; the body goes to
    // …/content. Save metadata first, then chain its fresh ETag to the body PUT.
    let etag = loaded.etag;
    if (Object.keys(draft).length > 0) {
      const result = await gateway.updateSpec(spec.id, draft, etag);
      if (!result.ok) return saveError(result.error);
      etag = result.etag ?? etag;
    }
    if (bodyDraft !== loaded.body) {
      const result = await gateway.putSpecContent(spec.id, { body: bodyDraft }, etag);
      if (!result.ok) return saveError(result.error);
    }
    setEditing(false);
    setDraft({});
    void load();
    showToast("success", `${spec.id} updated.`);
  };

  const restore = async (rev: number) => {
    setRestoring(null);
    const result = await gateway.restoreSpec(spec.id, rev);
    if (result.ok) {
      showToast("success", `${spec.id} restored to rev ${rev}.`);
      void load();
    } else {
      showToast("error", result.error.message);
    }
  };

  const propItem = (label: string, key: keyof SpecUpdateRequest, value: string) => (
    <div className="prop">
      <span className="prop-label">{label}</span>
      {editing ? (
        <Input
          className="prop-input"
          defaultValue={value}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        />
      ) : (
        <span className="prop-value">{value || "—"}</span>
      )}
    </div>
  );

  const roomId = spec.room_id ?? spec.id;
  const openTerminal = (request: { focus?: string; launch?: RoomTerminalRequest["launch"] }) =>
    onOpenTerminal({ roomId, project: spec.project, title: spec.title, ...request });

  // Live log and Stop stay inline while an agent runs; the lifecycle actions —
  // dispatch, invite, open terminal, edit — collapse into this one Actions menu.
  const actionItems: MenuNode[] = [
    ...(spec.status === "draft"
      ? []
      : [{
          kind: "item" as const,
          label: restart ? "Re-dispatch" : "Dispatch",
          onSelect: () => setDispatchOpen(true),
        }]),
    ...(spec.engagement
      ? []
      : [{
          kind: "item" as const,
          label: "Add agent",
          onSelect: () => setEngageOpen(true),
        }]),
    { kind: "item", label: "Run a task", onSelect: () => setInviteOpen(true) },
    openTerminalMenu((glyph) => openTerminal({ launch: glyph })),
    { kind: "item", label: "Edit", onSelect: startEdit },
  ];

  const dismissAgent = async () => {
    setDismissConfirm(false);
    const result = await gateway.disengage(spec.room_id ?? spec.id);
    if (!result.ok) {
      showToast("error", result.error.message);
      return;
    }
    showToast("info", result.value.agent ? `Dismissed ${result.value.agent} from ${spec.id}.` : "Nobody was engaged.");
    void load();
  };

  const openActionsMenu = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActionMenu({ x: rect.right, y: rect.bottom + 4 });
  };

  const roomHeader = (
    <RoomHeader
      title={spec.title}
      eyebrow={spec.id}
      presence={
        spec.engagement ? (
          // An invited agent owns the room's liveness: the roster chip already
          // says who's here and whether they're thinking. The generic
          // run-presence pill is for the other case — a dispatched agent
          // working autonomously with nobody engaged in the room.
          <RosterChip
            specId={specId}
            engagement={spec.engagement}
            onDismiss={role.canWrite ? () => setDismissConfirm(true) : undefined}
          />
        ) : (
          <PresenceChip specId={specId} verbose />
        )
      }
      drawerOpen={drawerOpen}
      onToggleDrawer={() => setDetailsOpen(!drawerOpen)}
      onBack={embedded ? undefined : onBack}
      actions={
        <>
          <RoomDeckStrip
            gateway={gateway}
            roomId={roomId}
            onSelect={(name) => openTerminal({ focus: name })}
          />
          {(spec.status === "in_progress" || spec.status === "review") && (
            <Button
              variant="ghost"
              disabled={!!logsOwner}
              title={logsOwner ? `Assigned to ${logsOwner} — logs live on their box.` : undefined}
              onClick={() => setLogOpen(true)}
              data-testid="follow-log"
            >
              {spec.status === "review" ? "Review log" : "Live log"}
            </Button>
          )}
          {spec.status === "in_progress" && (
            <Button
              className="btn-danger"
              onClick={() => void beginStop()}
              data-testid="detail-stop"
            >
              Stop
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={openActionsMenu}
            data-testid="detail-actions"
            aria-haspopup="menu"
          >
            Actions
            <CaretDown size={12} />
          </Button>
        </>
      }
    />
  );

  return (
    <div className="detail room-detail">
      {actionMenu && (
        <ContextMenu
          x={actionMenu.x}
          y={actionMenu.y}
          items={actionItems}
          onClose={() => setActionMenu(null)}
        />
      )}

      <div className="room-layout">
        <main className="room-conversation">
          {roomHeader}
          <SpecRoom
            gateway={gateway}
            engagement={spec.engagement}
            specId={spec.id}
            roomId={roomId}
            specStatus={spec.status}
            specTitle={spec.title}
            canWrite={
              role.canWrite &&
              spec.status !== "done" &&
              spec.status !== "cancelled" &&
              spec.status !== "archived"
            }
            currentUser={role.fde}
            onOpenLog={(role) => {
              setLogRole(role ?? null);
              setLogOpen(true);
            }}
          />
        </main>

        {drawerOpen && (
          <DetailsDrawer
            width={drawerWidth}
            onWidth={setDrawerWidth}
            onWidthCommit={(width) => localStorage.setItem(DRAWER_WIDTH_KEY, String(width))}
            onClose={() => setDetailsOpen(false)}
          >
            {loaded.enriched && unmet.length > 0 && (
              <p className="detail-blocked" data-testid="blocked-banner">
                Blocked — waiting on{" "}
                {unmet.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <DepChip id={id} unmet onOpen={onOpenSpec} />
                  </span>
                ))}
              </p>
            )}

            <section className="room-drawer-section">
              <h3>Metadata</h3>
              <div className="room-meta-grid">
                <div className="prop">
                  <span className="prop-label">Status</span>
                  {editing ? (
                    <Select
                      className="prop-status-select"
                      value={draft.status ?? spec.status}
                      options={STATUS_OPTIONS}
                      onChange={(v) => setDraft((d) => ({ ...d, status: v as SpecStatus }))}
                    />
                  ) : (
                    <span className="prop-value">{statusLabel(spec.status)}</span>
                  )}
                </div>
                <div className="prop prop-assignee">
                  <span className="prop-label">Assignee</span>
                  {editing ? (
                    fdes ? (
                      <Select
                        className="prop-status-select"
                        value={draft.assignee ?? spec.assignee ?? ""}
                        options={assigneeOptions(fdes, spec.assignee)}
                        onChange={(assignee) => setDraft((d) => ({ ...d, assignee }))}
                      />
                    ) : (
                      <Input
                        className="prop-input"
                        defaultValue={spec.assignee ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, assignee: e.target.value }))}
                      />
                    )
                  ) : (
                    <span className="prop-value">{spec.assignee || "—"}</span>
                  )}
                </div>
                {propItem("Agent", "agent", spec.agent ?? "")}
                {propItem("Model", "model", spec.model ?? "")}
                <div className="prop">
                  <span className="prop-label prop-label-hint">
                    Priority
                    <Tooltip content="Higher number = higher priority. Dispatch picks the highest-priority ready spec first.">
                      <span className="prop-hint-icon" tabIndex={0}><Info size={13} /></span>
                    </Tooltip>
                  </span>
                  {editing ? (
                    <NumberStepper
                      value={draft.priority ?? spec.priority}
                      min={0}
                      max={100}
                      step={10}
                      onChange={(priority) => setDraft((d) => ({ ...d, priority }))}
                    />
                  ) : (
                    <span className="prop-value">{spec.priority}</span>
                  )}
                </div>
                <div className="prop">
                  <span className="prop-label">Repos</span>
                  {editing ? (
                    <Input
                      className="prop-input"
                      defaultValue={(spec.repos ?? []).join(", ")}
                      placeholder="api, web"
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          repos: e.target.value.split(",").map((r) => r.trim()).filter(Boolean),
                        }))
                      }
                    />
                  ) : (
                    <span className="prop-value">{(spec.repos ?? []).join(", ") || "—"}</span>
                  )}
                </div>
                {editing && (
                  <div className="prop">
                    <span className="prop-label">Depends on</span>
                    <Input
                      className="prop-input prop-input-wide"
                      defaultValue={(spec.depends_on ?? []).join(", ")}
                      placeholder="spec-a, spec-b"
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          depends_on: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                        }))
                      }
                    />
                  </div>
                )}
                <div className="prop">
                  <span className="prop-label">Branch</span>
                  <span className="prop-value">{spec.branch ?? "—"}</span>
                </div>
              </div>
            </section>

            {loaded.plan && (
              <section className="room-drawer-section">
                <h3>Plan</h3>
                <Markdown source={loaded.plan} />
              </section>
            )}

            {((spec.depends_on ?? []).length > 0 || dependents.length > 0) && (
              <section className="room-drawer-section">
                <h3>Dependencies</h3>
                <div className="dep-section">
                  {(spec.depends_on ?? []).length > 0 && (
                    <>
                      <span className="eyebrow">Depends on</span>
                      <div className="dep-chips">
                        {(spec.depends_on ?? []).map((id) => (
                          <DepChip
                            key={id}
                            id={id}
                            unmet={loaded.enriched && unmet.includes(id)}
                            onOpen={onOpenSpec}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  {dependents.length > 0 && (
                    <>
                      <span className="eyebrow">Blocked by this</span>
                      <div className="dep-chips">
                        {dependents.map((dependent) => (
                          <DepChip
                            key={dependent.id}
                            id={dependent.id}
                            unmet={false}
                            onOpen={onOpenSpec}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </section>
            )}

            <section className="room-drawer-section">
              <div className="room-drawer-section-head">
                <h3>Spec</h3>
                {editing && (
                  <div className="prop-actions">
                    <Button onClick={() => void saveMeta()}>Save</Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setDraft({});
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
              {editing ? (
                <div className="md-editor" data-pane={editorPane}>
                  <ToggleButton
                    className="md-editor__tabs"
                    options={EDITOR_PANES}
                    value={editorPane}
                    onChange={(v) => setEditorPane(v as "write" | "preview")}
                  />
                  <textarea
                    className="md-editor__input"
                    value={bodyDraft}
                    spellCheck={false}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    placeholder="Markdown…"
                  />
                  <div className="md-editor__preview">
                    <Markdown source={bodyDraft || "*No body yet.*"} />
                  </div>
                </div>
              ) : (
                <Markdown source={loaded.body || "*No body yet.*"} />
              )}
            </section>

            <section className="room-drawer-section">
              <h3>History</h3>
              {loaded.history.map((revision) => (
                <div key={revision.rev} className="history-row">
                  <span className="meta-value">
                    rev {revision.rev} · {revision.origin}
                    {revision.actor ? ` · ${revision.actor}` : ""}
                  </span>
                  <button
                    type="button"
                    className="dep-chip"
                    onClick={() => setRestoring(revision.rev)}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </section>
          </DetailsDrawer>
        )}
      </div>

      <Dialog
        isOpen={restoring !== null}
        onClose={() => setRestoring(null)}
        title={`Restore rev ${restoring}?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoring(null)}>
              Cancel
            </Button>
            <Button onClick={() => restoring !== null && void restore(restoring)}>Restore</Button>
          </>
        }
      >
        <p className="meta-value">
          The spec body and metadata return to revision {restoring}. The current state stays in
          history.
        </p>
      </Dialog>

      <Dialog
        isOpen={stopTarget !== null}
        onClose={() => setStopTarget(null)}
        title={`Stop ${spec.id}?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopTarget(null)}>
              Cancel
            </Button>
            <Button
              className="btn-danger"
              onClick={() => stopTarget && void confirmStop(stopTarget)}
              data-testid="confirm-stop"
            >
              Stop run
            </Button>
          </>
        }
      >
        <p className="meta-value">
          Stop run {stopTarget?.id}? The agent is killed and the spec becomes cancelled — it will
          not be dispatched again until you re-dispatch.
        </p>
      </Dialog>

      {dispatchOpen && (
        <DispatchDialog
          gateway={gateway}
          spec={spec}
          allSpecs={loaded.allSpecs}
          depsKnown={loaded.enriched}
          canDispatch={role.canDispatch}
          roleKnown={role.known}
          restart={restart}
          onClose={() => setDispatchOpen(false)}
          onResult={(message, ok) => {
            showToast(ok ? "success" : "error", message);
            if (ok) void load();
          }}
        />
      )}

      {inviteOpen && (
        <InviteDialog
          gateway={gateway}
          spec={spec}
          canDispatch={role.canDispatch}
          roleKnown={role.known}
          onClose={() => setInviteOpen(false)}
          onResult={(message, ok) => {
            showToast(ok ? "success" : "error", message);
          }}
        />
      )}

      {engageOpen && (
        <EngageDialog
          gateway={gateway}
          specId={spec.id}
          canDispatch={role.canDispatch}
          roleKnown={role.known}
          onClose={() => setEngageOpen(false)}
          onResult={(message, ok) => {
            showToast(ok ? "success" : "error", message);
            if (ok) void load();
          }}
        />
      )}

      <Dialog
        isOpen={dismissConfirm}
        onClose={() => setDismissConfirm(false)}
        title="Dismiss this agent?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDismissConfirm(false)}>
              Cancel
            </Button>
            <Button
              className="btn-danger"
              onClick={() => void dismissAgent()}
              data-testid="confirm-dismiss"
            >
              Dismiss
            </Button>
          </>
        }
      >
        <p className="meta-value">
          {spec.engagement?.agent ?? "The agent"} leaves the room and stops answering messages.
          The conversation history stays.
        </p>
      </Dialog>

      {logOpen && (
        <LiveLog
          gateway={gateway}
          project={spec.project}
          specId={spec.id}
          initialRole={logRole ?? (spec.status === "review" ? "review" : "build")}
          onClose={() => { setLogOpen(false); setLogRole(null); }}
        />
      )}
    </div>
  );
}
