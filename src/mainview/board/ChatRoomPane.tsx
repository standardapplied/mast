import { useEffect, useState } from "react";
import type { EngagementView, GlobalSpecView, ServerRoomView } from "../../shared/sail-models";
import { DetailsDrawer } from "../components/DetailsDrawer";
import { RoomHeader } from "../components/RoomHeader";
import type { DeckServices } from "../terminal/roomDeck";
import { statusLabel } from "./lifecycle";
import { RoomDeckPanel } from "./RoomDeckPanel";
import { RosterChip } from "./RosterChip";
import { SpecRoom } from "./SpecRoom";
import type { Gateway } from "../gateway";

const DRAWER_OPEN_KEY = "mast.room.details.chat.open";
const DRAWER_WIDTH_KEY = "mast.room.details.width";

function storedWidth(): number {
  const parsed = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
  return Number.isFinite(parsed) && parsed >= 320 && parsed <= 640 ? parsed : 380;
}

/**
 * The conversation pane of a room with no attached spec: the same chat surface as a
 * spec's room, with the room's own identity in the header, the terminal deck on top,
 * and a drawer listing the specs born here — the room shows what the brainstorm
 * produced; dispatch stays where the spec lives.
 */
export function ChatRoomPane({
  gateway,
  room,
  deck,
  onOpenLog = () => {},
}: {
  gateway: Gateway;
  room: ServerRoomView;
  /** The room deck's terminal edge, injected by the Tauri entry (absent in demo/tests). */
  deck?: DeckServices;
  onOpenLog?: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(() => localStorage.getItem(DRAWER_OPEN_KEY) === "true");
  const [drawerWidth, setDrawerWidth] = useState(storedWidth);
  const [specs, setSpecs] = useState<GlobalSpecView[]>([]);

  const setDetailsOpen = (open: boolean) => {
    setDrawerOpen(open);
    localStorage.setItem(DRAWER_OPEN_KEY, String(open));
  };

  useEffect(() => {
    if (!drawerOpen || room.spec_ids.length === 0) return;
    let cancelled = false;
    void gateway.listSpecs({}).then((result) => {
      if (cancelled || !result.ok) return;
      const ids = new Set(room.spec_ids);
      setSpecs(result.value.specs.filter((spec) => ids.has(spec.id)));
    });
    return () => {
      cancelled = true;
    };
  }, [gateway, drawerOpen, room.spec_ids]);

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
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDetailsOpen(!drawerOpen)}
          actions={
            engagement && <RosterChip specId={room.id} engagement={engagement} />
          }
        />
        <RoomDeckPanel gateway={gateway} roomId={room.id} project={room.project} services={deck}>
          <SpecRoom
            gateway={gateway}
            specId={room.id}
            roomId={room.id}
            specTitle={room.title}
            canWrite
            engagement={engagement}
            onOpenLog={onOpenLog}
          />
        </RoomDeckPanel>
      </main>
      {drawerOpen && (
        <DetailsDrawer
          width={drawerWidth}
          onWidth={setDrawerWidth}
          onWidthCommit={(width) => localStorage.setItem(DRAWER_WIDTH_KEY, String(width))}
          onClose={() => setDetailsOpen(false)}
        >
          <section className="room-drawer-section">
            <h3>Specs born here</h3>
            {room.spec_ids.length === 0 ? (
              <p className="room-drawer-empty">
                None yet — a spec created from this room's terminals lands here.
              </p>
            ) : (
              <ul className="room-spec-list">
                {room.spec_ids.map((id) => {
                  const spec = specs.find((s) => s.id === id);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="room-spec-link"
                        data-testid={`room-spec-${id}`}
                        onClick={() => {
                          location.hash = `#/spec/${encodeURIComponent(id)}`;
                        }}
                      >
                        <span className="room-spec-link__title">{spec?.title ?? id}</span>
                        {spec && (
                          <span className="room-spec-link__status">{statusLabel(spec.status)}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </DetailsDrawer>
      )}
    </div>
  );
}
