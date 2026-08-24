import type { ReactNode } from "react";
import { CaretLeft, PanelRight } from "./icons";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

export function RoomHeader({
  title,
  eyebrow,
  presence,
  drawerOpen,
  onToggleDrawer,
  onBack,
  actions,
}: {
  title: string;
  /** Stable identifier (the spec id), shown small beside the presence. */
  eyebrow?: string;
  /** Liveness chip for the spec's running agent — the header's only status cue. */
  presence?: ReactNode;
  drawerOpen?: boolean;
  /** Omit to render a header without a details drawer at all (chat-only rooms). */
  onToggleDrawer?: () => void;
  onBack?: () => void;
  actions?: ReactNode;
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
            {eyebrow && <span className="room-header-id">{eyebrow}</span>}
            {presence}
          </div>
        </div>
      </div>
      <div className="room-header-actions detail-header-actions">
        {actions && <div className="room-header-inline-actions">{actions}</div>}
        {onToggleDrawer && (
          <Tooltip content={drawerOpen ? "Hide details" : "Details"}>
            <Button
              variant="ghost"
              icon
              aria-label={drawerOpen ? "Hide details" : "Details"}
              aria-expanded={drawerOpen ?? false}
              aria-controls="room-details-drawer"
              onClick={onToggleDrawer}
              data-testid="details-toggle"
            >
              <PanelRight size={16} />
            </Button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
