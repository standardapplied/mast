import type { ReactNode } from "react";
import { cx } from "./cx";

export function KanbanBoard({ children }: { children: ReactNode }) {
  return <div className="kanban-board">{children}</div>;
}

export function KanbanColumn({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="kanban-column">
      <div className="kanban-column-header">
        <span className="eyebrow">{title}</span>
        {count !== undefined && <span className="kanban-count">{count}</span>}
      </div>
      <div className="kanban-column-body">{children}</div>
    </div>
  );
}

export function KanbanCard({
  title,
  meta,
  children,
  active = false,
  onClick,
}: {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={cx("kanban-card", active && "is-active")} onClick={onClick}>
      <span className="kanban-card-title">{title}</span>
      {children}
      {meta && <span className="kanban-card-meta">{meta}</span>}
    </button>
  );
}
