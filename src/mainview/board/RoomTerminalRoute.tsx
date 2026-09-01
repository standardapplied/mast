import { useEffect, useState } from "react";
import { CaretLeft } from "../components/icons";
import { Tooltip } from "../components/Tooltip";
import type { Gateway } from "../gateway";
import type { DeckServices, RoomTerminalRequest } from "../terminal/roomDeck";
import { DeckAttachUnavailable } from "./RoomDeck";

/**
 * The room's terminal route: a full-screen workbench you reach THROUGH a room,
 * never from the rail. The bar is the single-level way back — chevron + room
 * title returns to the room (Rooms view) or spec detail (Board view) exactly
 * where it was, badged with the messages the room posted while you worked. The
 * body is the injected Tauri workbench (the Terminal view's machinery scoped to
 * this room); without it (demo, tests) the attach explains itself.
 */
export function RoomTerminalRoute({
  gateway,
  request,
  services,
  active,
  onBack,
}: {
  gateway: Gateway;
  request: RoomTerminalRequest;
  /** The room workbench, injected by the Tauri entry (absent in demo/tests). */
  services?: DeckServices;
  /** False while the route is hidden — parks terminal focus and drawing. */
  active: boolean;
  onBack: () => void;
}) {
  // The room keeps talking while you work; the badge says how much.
  const [unread, setUnread] = useState(0);
  useEffect(
    () =>
      gateway.onEvent((event) => {
        if (event.type !== "spec_message_posted" || event.spec !== request.roomId) return;
        setUnread((count) => count + 1);
      }),
    [gateway, request.roomId],
  );

  return (
    <div className="room-route" data-testid="room-route">
      <div className="room-route__bar" data-testid="room-route-bar">
        <Tooltip content="Back to the room">
          <button
            type="button"
            className="room-route__back"
            data-testid="route-back"
            aria-label={`Back to ${request.title}`}
            onClick={onBack}
          >
            <CaretLeft size={14} />
            <span className="room-route__room">{request.title}</span>
            {unread > 0 && (
              <span className="room-route__unread" data-testid="route-unread">
                {unread}
              </span>
            )}
          </button>
        </Tooltip>
        <span className="room-route__context" data-testid="route-context">
          {request.roomId} · {request.project}
        </span>
      </div>
      <div className="room-route__body">
        {services ? (
          <services.Workbench
            gateway={gateway}
            roomId={request.roomId}
            project={request.project}
            active={active}
            focus={request.focus}
            launch={request.launch}
          />
        ) : (
          <DeckAttachUnavailable session={request.focus ?? request.roomId} />
        )}
      </div>
    </div>
  );
}
