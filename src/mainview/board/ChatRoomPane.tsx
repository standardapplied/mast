import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { EngagementView, ServerRoomView } from "../../shared/sail-models";
import { ContextMenu } from "../components/ContextMenu";
import { DetailsDrawer } from "../components/DetailsDrawer";
import { CaretDown } from "../components/icons";
import { RoomHeader } from "../components/RoomHeader";
import { Button } from "../components/ui";
import type { RoomTerminalRequest } from "../terminal/roomDeck";
import { statusLabel } from "./lifecycle";
import { openTerminalMenu, RoomDeckStrip } from "./RoomDeck";
import { RosterChip } from "./RosterChip";
import { SpecRoom } from "./SpecRoom";
import type { Gateway } from "../gateway";
import { catalogStore, connectCatalog } from "./catalogStore";

const DRAWER_OPEN_KEY = "mast.room.details.chat.open";
const DRAWER_WIDTH_KEY = "mast.room.details.width";

function storedWidth(): number {
  const parsed = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
  return Number.isFinite(parsed) && parsed >= 320 && parsed <= 640 ? parsed : 380;
}

/**
 * The conversation pane of a room with no attached spec: the same chat surface as a
 * spec's room, with the room's own identity in the header, the terminal deck's cards
 * before the actions, and a drawer listing the specs born here — the room shows what
 * the brainstorm produced; dispatch stays where the spec lives.
 */
export function ChatRoomPane({
  gateway,
  room,
  onOpenTerminal,
  onOpenLog = () => {},
}: {
  gateway: Gateway;
  room: ServerRoomView;
  /** Navigate to the room's full-screen terminal route. */
  onOpenTerminal: (request: RoomTerminalRequest) => void;
  onOpenLog?: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(() => localStorage.getItem(DRAWER_OPEN_KEY) === "true");
  const [drawerWidth, setDrawerWidth] = useState(storedWidth);
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number } | null>(null);

  const setDetailsOpen = (open: boolean) => {
    setDrawerOpen(open);
    localStorage.setItem(DRAWER_OPEN_KEY, String(open));
  };

  useEffect(() => connectCatalog(gateway), [gateway]);
  const catalogVersion = useSyncExternalStore(catalogStore.subscribe, () => catalogStore.version);
  const specs = useMemo(() => {
    const ids = new Set(room.spec_ids);
    return catalogStore.specList().filter((spec) => ids.has(spec.id));
    // catalogVersion is the store's change signal; specList reads fresh through it.
  }, [room.spec_ids, catalogVersion]);

  const openTerminal = (request: { focus?: string; launch?: RoomTerminalRequest["launch"] }) =>
    onOpenTerminal({ roomId: room.id, project: room.project, title: room.title, ...request });

  const member = room.members[0];
  const engagement: EngagementView | undefined = member && {
    agent: member.agent,
    mode: member.mode,
    ...(member.model ? { model: member.model } : {}),
    engaged_at: member.engaged_at,
  };
  return (
    <div className="room-layout">
      {actionMenu && (
        <ContextMenu
          x={actionMenu.x}
          y={actionMenu.y}
          items={[openTerminalMenu((glyph) => openTerminal({ launch: glyph }))]}
          onClose={() => setActionMenu(null)}
        />
      )}
      <main className="room-conversation">
        <RoomHeader
          title={room.title}
          eyebrow={room.id}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDetailsOpen(!drawerOpen)}
          actions={
            <>
              <RoomDeckStrip
                roomId={room.id}
                onSelect={(name) => openTerminal({ focus: name })}
              />
              {engagement && <RosterChip specId={room.id} engagement={engagement} />}
              <Button
                variant="ghost"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setActionMenu({ x: rect.right, y: rect.bottom + 4 });
                }}
                data-testid="room-actions"
                aria-haspopup="menu"
              >
                Actions
                <CaretDown size={12} />
              </Button>
            </>
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
