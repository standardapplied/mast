import { useMemo, useSyncExternalStore } from "react";
import type { EngagementView } from "../../shared/sail-models";
import { Tooltip } from "../components/Tooltip";
import { presenceStore, type PresenceStore } from "./presenceStore";

/**
 * The room's roster: who is engaged here, with what access, and whether they
 * are thinking right now. "Thinking" is a live chat turn (the presence store's
 * chat-lane entry exists); otherwise the agent is idle-but-present — engaged,
 * answering the next message. Renders nothing when nobody is engaged; the
 * composer's status line handles that truth instead.
 */
export function RosterChip({
  specId,
  engagement,
  onDismiss,
  store = presenceStore,
  now = Date.now,
}: {
  specId: string;
  engagement?: EngagementView;
  onDismiss?: () => void;
  store?: PresenceStore;
  now?: () => number;
}) {
  const version = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.version,
  );
  const thinking = useMemo(
    () => store.chatPresenceOf(specId, now()) !== null,
    [store, specId, now, version],
  );
  if (!engagement) return null;
  const mode = engagement.mode === "full" ? "full" : "read only";
  return (
    <span
      className={`presence-chip roster-chip is-${thinking ? "working" : "idle"}`}
      data-testid={`roster-${specId}`}
      title={`${engagement.agent} is in this room (${mode}) and answers every message.`}
    >
      <span className="presence-chip__label">
        {engagement.agent} · {mode} · {thinking ? "thinking…" : "in the room"}
      </span>
      {onDismiss && (
        <Tooltip content="Dismiss from this room">
          <button
            type="button"
            className="roster-dismiss"
            aria-label={`Dismiss ${engagement.agent}`}
            onClick={onDismiss}
            data-testid={`roster-dismiss-${specId}`}
          >
            ×
          </button>
        </Tooltip>
      )}
    </span>
  );
}
