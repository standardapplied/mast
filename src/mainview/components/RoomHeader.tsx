import type { ReactNode } from "react";
import { CaretLeft, PanelRight } from "./icons";
import { Tooltip } from "./Tooltip";
import { Badge, Button, type BadgeTone } from "./ui";

export function RoomHeader({
  title,
  status,
  statusTone,
  guidance,
  drawerOpen,
  onToggleDrawer,
  onBack,
  actions,
  compactActions,
}: {
  title: string;
  status: string;
  statusTone: BadgeTone;
  guidance?: string;
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
        <div className="room-header-copy">
          <h1 className="room-header-title detail-title">{title}</h1>
          <div className="room-header-status">
            <Badge tone={statusTone}>{status}</Badge>
            {guidance && <span className="room-header-guidance">{guidance}</span>}
          </div>
        </div>
      </div>
      <div className="room-header-actions detail-header-actions">
        {actions && <div className="room-header-inline-actions">{actions}</div>}
        {compactActions && <div className="room-header-compact-actions">{compactActions}</div>}
        <Tooltip content={drawerOpen ? "Hide details" : "Details"}>
          <Button
            variant="ghost"
            className="room-details-toggle"
            aria-label={drawerOpen ? "Hide details" : "Details"}
            aria-expanded={drawerOpen}
            aria-controls="room-details-drawer"
            onClick={onToggleDrawer}
            data-testid="details-toggle"
          >
            <PanelRight size={16} />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
