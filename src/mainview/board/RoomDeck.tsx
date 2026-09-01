import { useEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import type { MenuNode } from "../components/ContextMenu";
import { cx } from "../components/cx";
import { Dialog } from "../components/Dialog";
import { DropdownPanel } from "../components/DropdownPanel";
import { Tooltip } from "../components/Tooltip";
import { Button } from "../components/ui";
import type { Gateway } from "../gateway";
import {
  chipTitle,
  DECK_LAUNCHERS,
  type DeckGlyph,
  type DeckSession,
  GLYPH_MARKS,
  glyphFor,
  observerCount,
  type RoomSessionGroup,
  skewCard,
  type SkewSide,
} from "../terminal/roomDeck";
import { useRoomSessions } from "./useRoomSessions";

/**
 * The room deck's presentation: the header's card strip (one Ghostty-style card per
 * session, clicking one navigates to the room's terminal route), the Actions menu's
 * "Open terminal" submenu, the ended-session card the route's panes park on, and
 * the Terminal view's "Rooms" inventory. Pure props in, callbacks out — navigation
 * and attaching live above.
 */

/** The Actions menu's "Open terminal ▸ Shell / Claude Code / Codex" submenu node. */
export function openTerminalMenu(onOpen: (glyph: DeckGlyph) => void): MenuNode {
  return {
    kind: "item",
    label: "Open terminal",
    submenu: DECK_LAUNCHERS.map(({ glyph, label }) => ({
      kind: "item" as const,
      label: (
        <span className="deck-menu-launcher" data-testid={`deck-new-${glyph}`}>
          <span className={`deck-card__glyph deck-card__glyph--${glyph}`} aria-hidden>
            {GLYPH_MARKS[glyph]}
          </span>
          {label}
        </span>
      ),
      onSelect: () => onOpen(glyph),
    })),
  };
}

/**
 * The header's deck: one card per session (live first, corpses dimmed with their
 * reason), rendered inline before the room's actions. No sessions, no cards, no
 * reserved space. A pty handshake skew renders as a single warn card — the listing
 * itself is unknowable until one side is upgraded.
 */
export function RoomDeckCards({
  sessions,
  roomId,
  skew,
  reasons = {},
  onSelect,
}: {
  sessions: DeckSession[];
  roomId: string;
  skew?: SkewSide | null;
  /** Ended reasons by session, carried on the dimmed cards. */
  reasons?: Record<string, string>;
  onSelect: (name: string) => void;
}) {
  if (skew) {
    const card = skewCard(skew);
    return (
      <span className="deck-strip" data-testid="deck-strip">
        <Tooltip content={card.detail}>
          <span className="deck-skew-chip" data-testid="deck-skew">
            {card.title}
          </span>
        </Tooltip>
      </span>
    );
  }
  if (sessions.length === 0) return null;
  return (
    <span className="deck-strip" data-testid="deck-strip">
      {sessions.map((session) => {
        const glyph = glyphFor(session.command);
        const observers = observerCount(session);
        const title = chipTitle(session, roomId);
        return (
          <Tooltip
            key={session.name}
            content={session.live ? session.name : (reasons[session.name] ?? "ended")}
          >
            <button
              type="button"
              className={cx("deck-card", !session.live && "is-ended")}
              data-testid={`deck-card-${session.name}`}
              onClick={() => onSelect(session.name)}
            >
              <span className={`deck-card__glyph deck-card__glyph--${glyph}`} aria-hidden>
                {GLYPH_MARKS[glyph]}
              </span>
              <span className="deck-card__title">{title}</span>
              {!session.live && <span className="deck-card__state">ended</span>}
              {session.live && session.writerFde && <Avatar author={session.writerFde} />}
              {session.live && observers > 0 && (
                <span className="deck-card__observers">+{observers}</span>
              )}
            </button>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** The card strip wired to the live listing — what room headers actually mount. */
export function RoomDeckStrip({
  gateway,
  roomId,
  onSelect,
}: {
  gateway: Gateway;
  roomId: string;
  /** A card was clicked — navigate to the route focused on this session. */
  onSelect: (name: string) => void;
}) {
  const { sessions, skew, reasons } = useRoomSessions(gateway, roomId);
  return (
    <RoomDeckCards
      sessions={sessions ?? []}
      roomId={roomId}
      skew={skew}
      reasons={reasons}
      onSelect={onSelect}
    />
  );
}

/**
 * The corpse card: what ended and why, with the revive verb — except a session a
 * dispatch displaced, which only reopens once no dispatch is live on its spec.
 */
export function DeckEndedCard({
  session,
  reason,
  yielded = false,
  dispatchLive = false,
  onRestart,
}: {
  session: string;
  reason?: string;
  yielded?: boolean;
  dispatchLive?: boolean;
  onRestart?: () => void;
}) {
  return (
    <div className="room-deck-card" data-testid="deck-ended-card">
      <div className="room-deck-card__title">Session ended</div>
      <div className="room-deck-card__reason">{reason ?? session}</div>
      {yielded && dispatchLive ? (
        <div className="room-deck-card__note">
          A dispatch is live on this spec — reopen after it finishes.
        </div>
      ) : (
        onRestart && (
          <button type="button" className="term-overlay__btn" onClick={onRestart}>
            {yielded ? "Reopen" : "Restart shell"}
          </button>
        )
      )}
    </div>
  );
}

/** The skew card the route parks on when the listing itself is unknowable. */
export function DeckSkewCard({ side }: { side: SkewSide }) {
  const card = skewCard(side);
  return (
    <div className="room-deck-card" data-testid="deck-skew-card">
      <div className="room-deck-card__title">{card.title}</div>
      <div className="room-deck-card__reason">{card.detail}</div>
    </div>
  );
}

/** The demo/browser stand-in for a live attach: the deck is data, terminals are the app's. */
export function DeckAttachUnavailable({ session }: { session: string }) {
  return (
    <div className="room-deck-card" data-testid="deck-attach-unavailable">
      <div className="room-deck-card__title">{session}</div>
      <div className="room-deck-card__reason">Terminals attach in the Mast app.</div>
    </div>
  );
}

/**
 * The Terminal view's "Rooms" group: the operator's whole-box inventory keeps room
 * sessions visible, collapsed behind one trigger. Rows are grouped by room with the
 * room's title; clicking a row JUMPS to that room's terminal route — its home
 * surface — instead of attaching in place. Kill stays available with the usual
 * confirm: the operator's escape hatch for an orphaned agent shell.
 */
export function RoomsInventory({
  groups,
  onJump,
  onKill,
}: {
  groups: RoomSessionGroup[];
  onJump: (group: RoomSessionGroup, session: DeckSession) => void;
  onKill: (session: DeckSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState<DeckSession | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (groups.length === 0) return null;
  const liveCount = groups.reduce(
    (n, group) => n + group.sessions.filter((s) => s.live).length,
    0,
  );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx("rooms-inventory-trigger", open && "is-active")}
        data-testid="rooms-inventory-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Rooms
        {liveCount > 0 && <span className="rooms-inventory-trigger__count">{liveCount}</span>}
      </button>
      <DropdownPanel triggerRef={triggerRef} isOpen={open} minWidth={280} maxHeight={480}>
        <div className="rooms-inventory" data-testid="rooms-inventory" ref={panelRef}>
          {groups.map((group) => (
            <div key={group.roomId} className="rooms-inventory__group">
              <div className="rooms-inventory__room">{group.title}</div>
              {group.sessions.map((session) => {
                const glyph = glyphFor(session.command);
                return (
                  <button
                    key={session.name}
                    type="button"
                    className={cx("rooms-inventory__row", !session.live && "is-ended")}
                    data-testid={`inventory-${session.name}`}
                    onClick={() => {
                      setOpen(false);
                      onJump(group, session);
                    }}
                  >
                    <span className={`deck-card__glyph deck-card__glyph--${glyph}`} aria-hidden>
                      {GLYPH_MARKS[glyph]}
                    </span>
                    <span className="rooms-inventory__name">
                      {chipTitle(session, group.roomId)}
                    </span>
                    {!session.live && <span className="deck-card__state">ended</span>}
                    <span
                      role="button"
                      aria-label={`Close session ${session.name}`}
                      className="deck-card__close"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpen(false);
                        setClosing(session);
                      }}
                    >
                      ×
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </DropdownPanel>
      {closing && (
        <Dialog
          isOpen
          onClose={() => setClosing(null)}
          title={`Close session ${closing.name}?`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(null)}>
                Cancel
              </Button>
              <Button
                className="btn-danger"
                onClick={() => {
                  const session = closing;
                  setClosing(null);
                  onKill(session);
                }}
              >
                Close
              </Button>
            </>
          }
        >
          <p>
            The session and anything running in it will end for everyone in the room.
            Detaching instead leaves it running.
          </p>
        </Dialog>
      )}
    </>
  );
}
