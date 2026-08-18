import type { ReactNode } from "react";
import { CaretLeft, PanelRight } from "./icons";
import { Tooltip } from "./Tooltip";
import { Button, type BadgeTone } from "./ui";

export function RoomHeader({
  title,
  eyebrow,
  status,
  statusTone,
  guidance,
  presence,
  drawerOpen,
  onToggleDrawer,
  onBack,
  actions,
  compactActions,
}: {
  title: string;
  /** Stable identifier (the spec id) shown small above the human title. */
  eyebrow?: string;
  status: string;
  statusTone: BadgeTone;
  guidance?: string;
  /** Liveness chip for the spec's running agent, rendered beside the status. */
  presence?: ReactNode;
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
          {eyebrow && <span className="room-header-eyebrow">{eyebrow}</span>}
          <h1 className="room-header-title detail-title">{title}</h1>
          <div className="room-header-status">
            <span className="room-header-statustext" data-tone={statusTone}>
              {status}
            </span>
            {presence}
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
            icon
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
