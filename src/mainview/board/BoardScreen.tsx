import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { GlobalSpecView, SpecFilter, SpecStatus } from "../../shared/sail-models";
import { Checkbox } from "../components/Checkbox";
import { DropdownPanel } from "../components/DropdownPanel";
import { Input } from "../components/Input";
import { Funnel, Magnifier } from "../components/icons";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { Badge, Button, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { BOARD_COLUMNS, canTransition, STATUS_LABEL } from "./lifecycle";
import { unmetDependencies, useBoard } from "./useBoard";

const LANES_KEY = "mast.board.lanes";

const STATUS_TONE: Record<SpecStatus, "accent" | "warning" | "success" | "neutral"> = {
  draft: "neutral",
  pending: "neutral",
  in_progress: "accent",
  review: "warning",
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
  onOpen,
  onDragStart,
}: {
  spec: GlobalSpecView;
  blockedBy: string[];
  onOpen: () => void;
  onDragStart: (event: DragEvent) => void;
}) {
  return (
    <button
      type="button"
      className="kanban-card"
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
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
        <span>{spec.assignee ?? "—"}</span>
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
  onRetry,
}: {
  error: NonNullable<ReturnType<typeof useBoard>["data"]["error"]>;
  server: string | undefined;
  onRetry: () => void;
}) {
  const unreachable = error.status === 0;
  return (
    <div className="board-error" data-testid="board-error">
      {unreachable ? (
        <>
          <p className="board-error-title">
            Can’t reach the control plane{server ? ` at ${server}` : ""}.
          </p>
          <p className="board-error-hint">
            The API listens on the node’s loopback — from this machine you need the SSH tunnel
            (<code>ssh -L 7070:localhost:7070 &lt;your-node&gt;</code>) or a reachable{" "}
            <code>server:</code> in <code>~/.sail/config.yaml</code>. The CLI’s SSH-gateway lane
            works without a tunnel; Mast speaks HTTP.
          </p>
        </>
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
}: {
  gateway: Gateway;
  onOpenSpec: (id: string) => void;
  server?: string;
}) {
  const [project, setProject] = useState<string | undefined>(undefined);
  const [onlyMine, setOnlyMine] = useState(false);
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState<string | undefined>(undefined);
  const [visibleLanes, setVisibleLanes] = useState<Set<SpecStatus>>(loadLanes);
  const [dragging, setDragging] = useState<GlobalSpecView | null>(null);
  const [dropTarget, setDropTarget] = useState<SpecStatus | null>(null);
  const [view, setView] = useState<{ left: number; width: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  const filter: SpecFilter = useMemo(
    () => ({ assignee: onlyMine ? "me" : undefined, q: query || undefined, repo }),
    [onlyMine, query, repo],
  );
  const { data, byStatus, move, refresh } = useBoard(gateway, project, filter);

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

  const handleDrop = async (to: SpecStatus) => {
    const spec = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!spec || !canTransition(spec.status, to)) return;

    const outcome = await move(spec.id, to);
    if (outcome === "conflict") {
      showToast(
        "error",
        `${spec.id} was changed by someone else — board reloaded, your move was not applied.`,
      );
    } else if (outcome === "error") {
      showToast("error", `Could not move ${spec.id}.`);
    }
  };

  return (
    <div className="board">
      <div className="masthead">
        <div className="masthead-title">
          <Eyebrow>Spec board</Eyebrow>
          {data.summary && (
            <div className="masthead-stats">
              <span className="stat">
                <span className="stat-value">{data.summary.in_progress}</span>
                <span className="stat-label">in progress</span>
              </span>
              <span className="stat-divider" />
              <span className="stat">
                <span className="stat-value">{data.summary.review}</span>
                <span className="stat-label">in review</span>
              </span>
            </div>
          )}
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

      {data.error && <ConnectionError error={data.error} server={server} onRetry={() => void refresh()} />}

      <div className="board-canvas-wrap">
        <div className="board-canvas" ref={canvasRef}>
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
                  onDragOver={(e) => {
                    if (droppable) {
                      e.preventDefault();
                      setDropTarget(status);
                    }
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === status ? null : t))}
                  onDrop={() => void handleDrop(status)}
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
                        onOpen={() => onOpenSpec(spec.id)}
                        onDragStart={(e) => {
                          e.dataTransfer?.setData("text/plain", spec.id);
                          setDragging(spec);
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {view && <Minimap lanes={lanes} view={view} onJump={jumpTo} />}
      </div>
    </div>
  );
}
