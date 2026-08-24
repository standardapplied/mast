import type { EngagementView, ServerRoomView } from "../../shared/sail-models";
import { RoomHeader } from "../components/RoomHeader";
import { RosterChip } from "./RosterChip";
import { SpecRoom } from "./SpecRoom";
import type { Gateway } from "../gateway";

/**
 * The conversation pane of a room with no attached spec: the same chat surface as a
 * spec's room, with the room's own identity in the header and its seated member as the
 * roster — no spec chrome, no details drawer, because there is no work-item to detail.
 * Writes are offered optimistically; the server's policy answer renders verbatim.
 */
export function ChatRoomPane({
  gateway,
  room,
  onOpenLog = () => {},
}: {
  gateway: Gateway;
  room: ServerRoomView;
  onOpenLog?: () => void;
}) {
  const member = room.members[0];
  const engagement: EngagementView | undefined = member && {
    agent: member.agent,
    mode: member.mode,
    ...(member.model ? { model: member.model } : {}),
    engaged_at: member.engaged_at,
  };
  return (
    <div className="room-layout">
      <main className="room-conversation">
        <RoomHeader
          title={room.title}
          eyebrow={room.id}
          actions={
            engagement && <RosterChip specId={room.id} engagement={engagement} />
          }
        />
        <SpecRoom
          gateway={gateway}
          specId={room.id}
          roomId={room.id}
          specTitle={room.title}
          canWrite
          engagement={engagement}
          onOpenLog={onOpenLog}
        />
      </main>
    </div>
  );
}
