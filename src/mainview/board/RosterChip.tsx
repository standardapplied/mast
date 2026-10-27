import type { EngagementView } from "../../shared/sail-models";
import { Tooltip } from "../components/Tooltip";

/**
 * Who is engaged in a spec's room and with what access, with the way to remove them. It never
 * says the agent is working: that is told once, in the timeline, while its turn is open.
 * Renders nothing when nobody is engaged.
 */
export function RosterChip({
  specId,
  engagement,
  onDismiss,
}: {
  specId: string;
  engagement?: EngagementView;
  onDismiss?: () => void;
}) {
  if (!engagement) return null;
  const name = engagement.agent_name ?? engagement.agent;
  const mode = engagement.mode === "full" ? "full" : "read only";
  return (
    <span
      className="presence-chip roster-chip"
      data-testid={`roster-${specId}`}
      title={`${name} is in this room (${mode}) and answers every message.`}
    >
      <span className="presence-chip__label">
        {name} · {mode}
      </span>
      {onDismiss && (
        <Tooltip content="Remove from this room">
          <button
            type="button"
            className="roster-remove"
            aria-label={`Remove ${name}`}
            onClick={onDismiss}
            data-testid={`roster-remove-${specId}`}
          >
            ×
          </button>
        </Tooltip>
      )}
    </span>
  );
}
