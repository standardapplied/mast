import { useMemo, useState, type DragEvent } from "react";
import type { GlobalSpecView, SpecFilter, SpecStatus } from "../../shared/sail-models";
import { Input } from "../components/Input";
import { Magnifier } from "../components/icons";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { Badge, Eyebrow } from "../components/ui";
import type { Gateway } from "../gateway";
import { BOARD_COLUMNS, canTransition, STATUS_LABEL } from "./lifecycle";
import { unmetDependencies, useBoard } from "./useBoard";

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
          <h1>{project ?? "All projects"}</h1>
          {data.summary && (
            <p className="masthead-summary">
              {data.summary.in_progress} in flight · {data.summary.review} in review
              {data.summary.next_ready_id ? (
                <>
                  {" · next "}
                  <button
                    type="button"
                    className="dep-chip"
                    onClick={() => onOpenSpec(data.summary!.next_ready_id!)}
                  >
                    {data.summary.next_ready_id}
                  </button>
                </>
              ) : null}
            </p>
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
        </div>
      </div>

      {data.error && <p className="board-error">{data.error}</p>}

      <div className="board-canvas">
        <div className="kanban-board board-columns">
        {BOARD_COLUMNS.map((status) => {
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
