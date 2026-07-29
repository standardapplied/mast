import type { ReactNode } from "react";
import { CaretLeft } from "./icons";
import { Badge, Button, type BadgeTone } from "./ui";

export function RoomHeader({
  title,
  status,
  statusTone,
  drawerOpen,
  onToggleDrawer,
  onBack,
  actions,
  compactActions,
}: {
  title: string;
  status: string;
  statusTone: BadgeTone;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onBack?: () => void;
  actions?: ReactNode;
  compactActions?: ReactNode;
}) {
  return (
    <header className="room-header">
      <div className="room-header-main">
        {onBack && (
          <button
            type="button"
            className="back-btn"
            onClick={onBack}
            aria-label="Back to board"
            data-testid="back-to-board"
          >
            <CaretLeft size={16} />
          </button>
        )}
        <h1 className="room-header-title detail-title">{title}</h1>
        <Badge tone={statusTone}>{status}</Badge>
      </div>
      <div className="room-header-actions detail-header-actions">
        {actions && <div className="room-header-inline-actions">{actions}</div>}
        {compactActions && <div className="room-header-compact-actions">{compactActions}</div>}
        <Button
          variant="ghost"
          aria-expanded={drawerOpen}
          aria-controls="room-details-drawer"
          onClick={onToggleDrawer}
          data-testid="details-toggle"
        >
          {drawerOpen ? "Hide details" : "Details"}
        </Button>
      </div>
    </header>
  );
}
