import { useMemo, useRef, useState, type DragEvent } from "react";
import type { GlobalSpecView, SpecFilter, SpecStatus } from "../../shared/sail-models";
import { DropdownPanel } from "../components/DropdownPanel";
import { Input } from "../components/Input";
import { CaretDown, Magnifier } from "../components/icons";
import { Select } from "../components/Select";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { Badge, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { BOARD_COLUMNS, canTransition, STATUS_LABEL } from "./lifecycle";
import { unmetDependencies, useBoard } from "./useBoard";

const LANES_KEY = "mast.board.lanes";

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

function LanesMenu({
  visible,
  onChange,
}: {
  visible: Set<SpecStatus>;
  onChange: (next: Set<SpecStatus>) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = (lane: SpecStatus, on: boolean) => {
    const next = new Set(visible);
    if (on) next.add(lane);
    else next.delete(lane);
    if (next.size === 0) return;
    localStorage.setItem(LANES_KEY, JSON.stringify([...next]));
    onChange(next);
  };

  return (
    <div
      className="lanes-menu"
      ref={containerRef}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) setIsOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="lanes-trigger"
        onClick={() => setIsOpen(!isOpen)}
        data-testid="lanes-trigger"
      >
        Lanes
        {visible.size < BOARD_COLUMNS.length && (
          <span className="lanes-count">{visible.size}</span>
        )}
        <CaretDown size={12} className={isOpen ? "select-caret is-open" : "select-caret"} />
      </button>
      <DropdownPanel triggerRef={triggerRef} isOpen={isOpen} maxHeight={280}>
        <div className="lanes-list">
          {BOARD_COLUMNS.map((lane) => {
            const on = visible.has(lane);
            return (
              <div key={lane} className="lanes-row" data-testid={`lane-toggle-${lane}`}>
                <span className="lanes-label">{STATUS_LABEL[lane]}</span>
                <Switch
                  checked={on}
                  disabled={on && visible.size === 1}
                  onChange={(next) => toggle(lane, next)}
                  label={`Show ${STATUS_LABEL[lane]}`}
                />
              </div>
            );
          })}
        </div>
      </DropdownPanel>
    </div>
  );
}

const STATUS_TONE: Record<SpecStatus, "accent" | "warning" | "success" | "neutral"> = {
  draft: "neutral",
  pending: "neutral",
  in_progress: "accent",
  review: "warning",
  done: "success",
  archived: "neutral",
};

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

export function BoardScreen({
  gateway,
  onOpenSpec,
}: {
  gateway: Gateway;
  onOpenSpec: (id: string) => void;
}) {
  const [project, setProject] = useState<string | undefined>(undefined);
  const [onlyMine, setOnlyMine] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleLanes, setVisibleLanes] = useState<Set<SpecStatus>>(loadLanes);
  const [dragging, setDragging] = useState<GlobalSpecView | null>(null);
  const [dropTarget, setDropTarget] = useState<SpecStatus | null>(null);
  const { showToast } = useToast();

  const filter: SpecFilter = useMemo(
    () => ({ assignee: onlyMine ? "me" : undefined, q: query || undefined }),
    [onlyMine, query],
  );
  const { data, byStatus, move } = useBoard(gateway, project, filter);

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
              {data.summary.next_ready_id && (
                <>
                  <span className="stat-divider" />
                  <span className="stat">
                    <span className="stat-label">next</span>
                    <button
                      type="button"
                      className="stat-link"
                      onClick={() => onOpenSpec(data.summary!.next_ready_id!)}
                    >
                      {data.summary.next_ready_id}
                    </button>
                  </span>
                </>
              )}
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
          <button
            type="button"
            className="tab"
            aria-selected={onlyMine}
            onClick={() => setOnlyMine(!onlyMine)}
          >
            Mine
          </button>
          <LanesMenu visible={visibleLanes} onChange={setVisibleLanes} />
        </div>
      </div>

      {data.error && <p className="board-error">{data.error}</p>}

      <div className="board-canvas">
        <div className="kanban-board board-columns">
        {BOARD_COLUMNS.filter((status) => visibleLanes.has(status)).map((status) => {
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
    </div>
  );
}
