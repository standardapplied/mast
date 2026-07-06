import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { GlobalSpecView, SpecFilter, SpecStatus } from "../../shared/sail-models";
import { Checkbox } from "../components/Checkbox";
import { ContextMenu, type MenuNode } from "../components/ContextMenu";
import { DropdownPanel } from "../components/DropdownPanel";
import { Input } from "../components/Input";
import { LoadingMark } from "../components/Loading";
import { DispatchDialog } from "./DispatchDialog";
import { Funnel, Magnifier } from "../components/icons";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { Badge, Button, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { BOARD_COLUMNS, canTransition, STATUS_LABEL } from "./lifecycle";
import { unmetDependencies, useBoard } from "./useBoard";

const LANES_KEY = "mast.board.lanes";

const STATUS_TONE: Record<SpecStatus, "accent" | "warning" | "success" | "info" | "neutral"> = {
  draft: "neutral",
  pending: "neutral",
  in_progress: "accent",
  review: "warning",
  awaiting_merge: "info",
  done: "success",
  archived: "neutral",
};

function loadLanes(): Set<SpecStatus> {
  try {
    const stored = JSON.parse(localStorage.getItem(LANES_KEY) ?? "[]") as SpecStatus[];
    const valid = stored.filter((s) => BOARD_COLUMNS.includes(s));
    if (valid.length > 0) return new Set(valid);
  } catch {
    // fall through to all lanes
  }
  return new Set(BOARD_COLUMNS);
}

function FilterMenu({
  onlyMine,
  onOnlyMine,
  visibleLanes,
  onLanes,
  repo,
  repoOptions,
  onRepo,
}: {
  onlyMine: boolean;
  onOnlyMine: (on: boolean) => void;
  visibleLanes: Set<SpecStatus>;
  onLanes: (next: Set<SpecStatus>) => void;
  repo: string | undefined;
  repoOptions: string[];
  onRepo: (repo: string | undefined) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const toggleLane = (lane: string, selected: boolean) => {
    const next = new Set(visibleLanes);
    if (selected) next.add(lane as SpecStatus);
    else next.delete(lane as SpecStatus);
    if (next.size === 0) return;
    localStorage.setItem(LANES_KEY, JSON.stringify([...next]));
    onLanes(next);
  };

  const hiddenLanes = BOARD_COLUMNS.length - visibleLanes.size;
  const activeCount = (onlyMine ? 1 : 0) + (hiddenLanes > 0 ? 1 : 0) + (repo ? 1 : 0);

  return (
    <div className="filter-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="lanes-trigger"
        onClick={() => setIsOpen(!isOpen)}
        data-testid="filter-trigger"
      >
        <Funnel size={13} />
        Filter
        {activeCount > 0 && <span className="lanes-count">{activeCount}</span>}
      </button>
      <DropdownPanel triggerRef={triggerRef} isOpen={isOpen} maxHeight={360} align="right" minWidth={248}>
        <div className="filter-panel" data-testid="filter-panel">
          <div className="filter-row" data-testid="filter-mine">
            <Checkbox checked={onlyMine} onChange={onOnlyMine} label="Only mine" />
          </div>
          {repoOptions.length > 0 && (
            <div className="filter-section" data-testid="filter-repo">
              <span className="eyebrow">Repo</span>
              <Select
                value={repo ?? ""}
                onChange={(value) => onRepo(value || undefined)}
                options={[
                  { value: "", label: "All repos" },
                  ...repoOptions.map((r) => ({ value: r, label: r })),
                ]}
                placeholder="All repos"
              />
            </div>
          )}
          <div className="filter-section" data-testid="filter-lanes">
            <span className="eyebrow">Lanes</span>
            <Select
              multiple
              placeholder="Lanes"
              values={[...visibleLanes]}
              onToggle={toggleLane}
              options={BOARD_COLUMNS.map((lane) => ({
                value: lane,
                label: STATUS_LABEL[lane],
                disabled: visibleLanes.has(lane) && visibleLanes.size === 1,
              }))}
            />
          </div>
        </div>
      </DropdownPanel>
    </div>
  );
}

function SpecCard({
  spec,
  blockedBy,
  lifted,
  onOpen,
  onPointerDown,
  onContextMenu,
}: {
  spec: GlobalSpecView;
  blockedBy: string[];
  lifted: boolean;
  onOpen: () => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={lifted ? "kanban-card is-lifted" : "kanban-card"}
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      data-testid={`card-${spec.id}`}
    >
      <span className="kanban-card-title">{spec.id}</span>
      <span className="spec-card-summary">{spec.title}</span>
      {blockedBy.length > 0 && (
        <span className="spec-card-blocked" title={`Blocked by ${blockedBy.join(", ")}`}>
          Blocked · {blockedBy.join(", ")}
        </span>
      )}
      <span className="kanban-card-meta">
        <span className={spec.assignee ? undefined : "spec-card-unassigned"}>
          {spec.assignee ?? "Unassigned"}
        </span>
        <span className="spec-card-agent">
          {spec.agent && `${spec.agent}${spec.model ? ` · ${spec.model}` : ""}`}
        </span>
        {spec.priority > 0 && <span className="spec-card-priority">P{spec.priority}</span>}
      </span>
    </button>
  );
}

function Minimap({
  lanes,
  view,
  onJump,
}: {
  lanes: SpecStatus[];
  view: { left: number; width: number };
  onJump: (fraction: number) => void;
}) {
  return (
    <div className="minimap" data-testid="board-minimap">
      <div className="minimap-track">
        {lanes.map((lane, index) => (
          <button
            key={lane}
            type="button"
            className="minimap-cell"
            title={STATUS_LABEL[lane]}
            onClick={() => onJump(index / lanes.length)}
          />
        ))}
        <span
          className="minimap-view"
          style={{ left: `${view.left * 100}%`, width: `${view.width * 100}%` }}
        />
      </div>
    </div>
  );
}

function ConnectionError({
  error,
  server,
  tokenPresent,
  onRetry,
}: {
  error: NonNullable<ReturnType<typeof useBoard>["data"]["error"]>;
  server: string | undefined;
  tokenPresent: boolean;
  onRetry: () => void;
}) {
  const noToken = !tokenPresent || error.code === "missing_bearer_token";
  const lostContact = error.status === 0;
  return (
    <div className="board-error" data-testid="board-error">
      {noToken ? (
        <>
          <p className="board-error-title">
            Connected{server ? ` to ${server}` : ""}, but no API token was found on this machine.
          </p>
          <p className="board-error-hint">
            The CLI’s SSH lane authenticates with your SSH key; Mast’s HTTP lane needs a token.
            Mint one on the node — <code>sail server token create mast member --fde &lt;you&gt;</code>{" "}
            — then add <code>token: &lt;value&gt;</code> to <code>~/.sail/config.yaml</code> here and
            hit Retry.
          </p>
        </>
      ) : lostContact ? (
        <p className="board-error-title">
          Lost contact with the control plane{server ? ` at ${server}` : ""} — it may be restarting
          or the connection dropped. Retrying…
        </p>
      ) : (
        <p className="board-error-title">
          {error.message}
          {error.action ? ` — ${error.action}` : ""}
        </p>
      )}
      <Button variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function BoardScreen({
  gateway,
  onOpenSpec,
  server,
  tokenPresent = true,
}: {
  gateway: Gateway;
  onOpenSpec: (id: string) => void;
  server?: string;
  tokenPresent?: boolean;
}) {
  const [project, setProjectState] = useState<string | undefined>(
    () => sessionStorage.getItem("mast.board.project") ?? undefined,
  );
  const [onlyMine, setOnlyMineState] = useState(
    () => sessionStorage.getItem("mast.board.mine") === "1",
  );
  const [query, setQuery] = useState("");
  const [repo, setRepoState] = useState<string | undefined>(
    () => sessionStorage.getItem("mast.board.repo") ?? undefined,
  );
  const [visibleLanes, setVisibleLanes] = useState<Set<SpecStatus>>(loadLanes);

  const setProject = (next: string | undefined) => {
    setProjectState(next);
    if (next) sessionStorage.setItem("mast.board.project", next);
    else sessionStorage.removeItem("mast.board.project");
  };
  const setOnlyMine = (next: boolean) => {
    setOnlyMineState(next);
    sessionStorage.setItem("mast.board.mine", next ? "1" : "0");
  };
  const setRepo = (next: string | undefined) => {
    setRepoState(next);
    if (next) sessionStorage.setItem("mast.board.repo", next);
    else sessionStorage.removeItem("mast.board.repo");
  };
  const [dragging, setDragging] = useState<GlobalSpecView | null>(null);
  const [dropTarget, setDropTarget] = useState<SpecStatus | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);
  const [view, setView] = useState<{ left: number; width: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; spec: GlobalSpecView } | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<GlobalSpecView | null>(null);
  const [role, setRole] = useState<{ canDispatch: boolean; known: boolean }>({
    canDispatch: false,
    known: false,
  });
  const canvasRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  // Fetch identity once so dispatch can be role-gated up front; if the server
  // has no whoami endpoint yet (404), role stays unknown and dispatch is
  // attempted, with the server's 403 handled cleanly.
  useEffect(() => {
    void gateway.whoami().then((result) => {
      if (result.ok) {
        setRole({ canDispatch: result.value.capabilities.includes("admin"), known: true });
      } else {
        setRole({ canDispatch: true, known: false });
      }
    });
  }, [gateway]);

  const filter: SpecFilter = useMemo(
    () => ({ assignee: onlyMine ? "me" : undefined, q: query || undefined, repo }),
    [onlyMine, query, repo],
  );
  const { data, byStatus, move, refresh } = useBoard(gateway, project, filter);

  // A lost-contact (status 0) error keeps retrying in the background — the
  // connection usually heals (bridge blip, node restart) without the user
  // needing to touch anything.
  useEffect(() => {
    if (data.error?.status !== 0) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [data.error, refresh]);

  // Force the grabbing cursor at the document root for the whole drag (native
  // HTML5 drag otherwise lets the OS reset it to an arrow mid-move).
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("is-dragging-active");
    return () => document.documentElement.classList.remove("is-dragging-active");
  }, [dragging]);

  const lanes = BOARD_COLUMNS.filter((status) => visibleLanes.has(status));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const update = () => {
      if (canvas.scrollWidth > canvas.clientWidth + 4) {
        setView({
          left: canvas.scrollLeft / canvas.scrollWidth,
          width: canvas.clientWidth / canvas.scrollWidth,
        });
      } else {
        setView(null);
      }
    };

    update();
    canvas.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      canvas.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [visibleLanes, data.specs]);

  const jumpTo = (fraction: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.scrollTo({ left: fraction * canvas.scrollWidth, behavior: "smooth" });
  };

  const projectOptions = [
    { value: "", label: "All projects" },
    ...data.projects.map((p) => ({ value: p, label: p })),
  ];

  const commitMove = async (spec: GlobalSpecView, to: SpecStatus) => {
    const { outcome, error } = await move(spec.id, to);
    if (outcome === "conflict") {
      showToast(
        "error",
        `${spec.id} was changed by someone else — board reloaded, your move was not applied.`,
      );
    } else if (outcome === "error") {
      showToast(
        "error",
        error
          ? `Couldn’t move ${spec.id}: ${error.message}${error.action ? ` — ${error.action}` : ""}`
          : `Couldn’t move ${spec.id}.`,
      );
    }
  };

  const laneAt = (x: number, y: number): SpecStatus | undefined => {
    const lane = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-column]");
    return (lane?.dataset.column as SpecStatus | undefined) || undefined;
  };

  // Pointer-based drag (not HTML5 DnD): Tauri's OS drag-drop — which the file
  // bridge needs — intercepts native drag events, so the board drives its own.
  const beginDrag = (spec: GlobalSpecView) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    const validTarget = (to?: SpecStatus) =>
      to && to !== spec.status && canTransition(spec.status, to) ? to : undefined;

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        active = true;
        setDragging(spec);
      }
      setGhost({ x: ev.clientX, y: ev.clientY });
      setDropTarget(validTarget(laneAt(ev.clientX, ev.clientY)) ?? null);
    };
    const finish = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (active) {
        draggedRef.current = true; // suppress the click that follows the drag
        setTimeout(() => (draggedRef.current = false), 0);
        const to = ev.type === "pointerup" ? validTarget(laneAt(ev.clientX, ev.clientY)) : undefined;
        if (to) void commitMove(spec, to);
      }
      setDragging(null);
      setDropTarget(null);
      setGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // The server accepts dispatch for any ready spec (dispatch doesn't check
  // ownership — this devbox's FDE can dispatch anyone's), so the rule mirrors
  // "ready": pending, assigned, no unmet dependencies. Role (admin) is enforced
  // inside the dialog, which can explain it.
  const menuItems = (spec: GlobalSpecView): MenuNode[] => {
    const unmet = unmetDependencies(spec, data.specs);
    const dispatchable = spec.status === "pending" && !!spec.assignee && unmet.length === 0;
    const hint =
      spec.status !== "pending"
        ? "Pending only"
        : !spec.assignee
          ? "Assign first"
          : unmet.length > 0
            ? "Blocked"
            : undefined;
    return [
      { kind: "item", label: "View", onSelect: () => onOpenSpec(spec.id) },
      { kind: "separator" },
      {
        kind: "item",
        label: "Dispatch…",
        disabled: !dispatchable,
        hint,
        onSelect: () => setDispatchTarget(spec),
      },
    ];
  };

  return (
    <div className={dragging ? "board is-dragging" : "board"}>
      <div className="masthead">
        <div className="masthead-title">
          <Eyebrow>Spec board</Eyebrow>
          <div className="masthead-stats">
            <span className="stat">
              <span className="stat-value">{byStatus.get("in_progress")?.length ?? 0}</span>
              <span className="stat-label">in progress</span>
            </span>
            <span className="stat-divider" />
            <span className="stat">
              <span className="stat-value">{byStatus.get("awaiting_merge")?.length ?? 0}</span>
              <span className="stat-label">awaiting merge</span>
            </span>
          </div>
        </div>
        <div className="board-controls">
          <Select
            className="board-project"
            value={project ?? ""}
            onChange={(value) => setProject(value || undefined)}
            options={projectOptions}
            placeholder="All projects"
          />
          <div className="board-search">
            <Input
              prefix={<Magnifier size={14} />}
              placeholder="Search specs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <FilterMenu
            onlyMine={onlyMine}
            onOnlyMine={setOnlyMine}
            visibleLanes={visibleLanes}
            onLanes={setVisibleLanes}
            repo={repo}
            repoOptions={data.repos}
            onRepo={setRepo}
          />
        </div>
      </div>

      {data.error && (
        <ConnectionError
          error={data.error}
          server={server}
          tokenPresent={tokenPresent}
          onRetry={() => void refresh()}
        />
      )}

      <div className="board-canvas-wrap">
        <div className="board-canvas" ref={canvasRef}>
          {data.loading && !data.error ? (
            <LoadingMark label="Loading specs" />
          ) : (
          <div className="kanban-board board-columns">
            {lanes.map((status) => {
              const specs = byStatus.get(status) ?? [];
              const droppable = dragging ? canTransition(dragging.status, status) : false;
              return (
                <div
                  key={status}
                  className={[
                    "kanban-column",
                    droppable && "is-droppable",
                    dropTarget === status && droppable && "is-drop-target",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid={`column-${status}`}
                  data-column={status}
                >
                  <div className="kanban-column-header">
                    <span className="eyebrow">{STATUS_LABEL[status]}</span>
                    <Badge tone={STATUS_TONE[status]}>{String(specs.length)}</Badge>
                  </div>
                  <div className="kanban-column-body">
                    {specs.map((spec) => (
                      <SpecCard
                        key={spec.id}
                        spec={spec}
                        blockedBy={unmetDependencies(spec, data.specs)}
                        lifted={dragging?.id === spec.id}
                        onOpen={() => {
                          if (draggedRef.current) return; // a drag just ended, not a click
                          onOpenSpec(spec.id);
                        }}
                        onPointerDown={beginDrag(spec)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ x: e.clientX, y: e.clientY, spec });
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          )}
        </div>
        {view && <Minimap lanes={lanes} view={view} onJump={jumpTo} />}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.spec)}
          onClose={() => setMenu(null)}
        />
      )}
      {dispatchTarget && (
        <DispatchDialog
          gateway={gateway}
          spec={dispatchTarget}
          allSpecs={data.specs}
          canDispatch={role.canDispatch}
          roleKnown={role.known}
          onClose={() => setDispatchTarget(null)}
          onResult={(message, ok) => {
            showToast(ok ? "success" : "error", message);
            if (ok) void refresh();
          }}
        />
      )}
      {dragging && ghost && (
        <div className="kanban-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="kanban-card-title">{dragging.id}</span>
          <span className="spec-card-summary">{dragging.title}</span>
        </div>
      )}
    </div>
  );
}
