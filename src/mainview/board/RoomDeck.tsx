import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Avatar } from "../components/Avatar";
import { ContextMenu } from "../components/ContextMenu";
import { cx } from "../components/cx";
import { DropdownPanel } from "../components/DropdownPanel";
import { CaretLeft, Terminal } from "../components/icons";
import { Tooltip } from "../components/Tooltip";
import { createPeek, type PeekScheduler, type PeekState } from "../terminal/peek";
import {
  chipTitle,
  type DeckGlyph,
  type DeckSession,
  glyphFor,
  observerCount,
  skewCard,
  type SkewSide,
} from "../terminal/roomDeck";

/**
 * The room deck's presentation: the header trigger (the open-terminal verb when the
 * room has no sessions, the deck popover's handle once it does), the popover of
 * session cards, the full-bleed stage's slim context bar, and the ended-session
 * card. Pure props in, callbacks out — the panel owns data and the Tauri edge owns
 * attaching.
 */

const GLYPH_MARKS: Record<DeckGlyph, string> = { claude: "✳", codex: "◆", shell: "❯" };

const PICKER: Array<{ glyph: DeckGlyph; label: string }> = [
  { glyph: "shell", label: "Shell" },
  { glyph: "claude", label: "Claude Code" },
  { glyph: "codex", label: "Codex" },
];

/**
 * The header slot: a bare `>_` that opens the shell/agent picker while the room has
 * no terminals — zero reserved space, attend is a primitive — and becomes the deck
 * trigger once sessions exist: live count badged on the glyph, click opening the
 * card popover, hover peeking it after a short delay with a grace path into the
 * panel. A pty handshake skew replaces the cards — the listing itself is unknowable.
 */
export function DeckMenu({
  sessions,
  roomId,
  titles = {},
  selected,
  skew,
  reasons = {},
  onSelect,
  onKill,
  onOpen,
  schedule,
}: {
  sessions: DeckSession[];
  roomId: string;
  /** Live OSC titles by session name, from panes attached in this app. */
  titles?: Record<string, string>;
  selected?: string | null;
  skew?: SkewSide | null;
  /** Ended reasons by session, carried on the dimmed cards. */
  reasons?: Record<string, string>;
  onSelect: (name: string) => void;
  onKill?: (session: DeckSession) => void;
  onOpen: (glyph: DeckGlyph) => void;
  /** Test seam for the hover-peek timers. */
  schedule?: PeekScheduler;
}) {
  const [state, setState] = useState<PeekState>("closed");
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const peek = useMemo(() => createPeek(setState, schedule), [schedule]);
  useEffect(() => () => peek.dispose(), [peek]);

  const hasDeck = sessions.length > 0 || !!skew;
  const liveCount = sessions.filter((s) => s.live).length;
  const open = hasDeck && state !== "closed";

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      peek.dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") peek.dismiss();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, peek]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={cx("deck-trigger", open && "is-open")}
      aria-label={hasDeck ? "Terminals" : "Open terminal"}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid="deck-trigger"
      onClick={(event) => {
        if (hasDeck) {
          peek.click();
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setPicker({ x: rect.left, y: rect.bottom + 4 });
      }}
      onMouseEnter={hasDeck ? () => peek.enterTrigger() : undefined}
      onMouseLeave={hasDeck ? () => peek.leave() : undefined}
    >
      <Terminal size={15} />
      {liveCount > 0 && (
        <span className="deck-trigger__count" data-testid="deck-count">
          {liveCount}
        </span>
      )}
      {liveCount > 0 && <span className="deck-trigger__dot" aria-hidden />}
      {skew && <span className="deck-trigger__dot deck-trigger__dot--warn" aria-hidden />}
    </button>
  );

  return (
    <>
      {hasDeck ? trigger : <Tooltip content="Open terminal">{trigger}</Tooltip>}
      <DropdownPanel triggerRef={triggerRef} isOpen={open} align="right" minWidth={300} maxHeight={480}>
        <div
          ref={panelRef}
          className="deck-pop"
          data-testid="deck-pop"
          onMouseEnter={() => peek.enterPanel()}
          onMouseLeave={() => peek.leave()}
        >
          {skew ? (
            <DeckSkew side={skew} />
          ) : (
            <>
              {sessions.map((session) => (
                <DeckCard
                  key={session.name}
                  session={session}
                  title={chipTitle(session, roomId, titles[session.name])}
                  active={selected === session.name}
                  reason={reasons[session.name]}
                  onSelect={() => {
                    peek.dismiss();
                    onSelect(session.name);
                  }}
                  onKill={
                    onKill &&
                    (() => {
                      peek.dismiss();
                      onKill(session);
                    })
                  }
                />
              ))}
              <div className="deck-pop__new">
                {PICKER.map(({ glyph, label }) => (
                  <button
                    key={glyph}
                    type="button"
                    className="deck-pop__new-item"
                    data-testid={`deck-new-${glyph}`}
                    onClick={() => {
                      peek.dismiss();
                      onOpen(glyph);
                    }}
                  >
                    <span className={`deck-card__glyph deck-card__glyph--${glyph}`} aria-hidden>
                      {GLYPH_MARKS[glyph]}
                    </span>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </DropdownPanel>
      {picker && (
        <ContextMenu
          x={picker.x}
          y={picker.y}
          onClose={() => setPicker(null)}
          items={PICKER.map(({ glyph, label }) => ({
            kind: "item" as const,
            label,
            onSelect: () => onOpen(glyph),
          }))}
        />
      )}
    </>
  );
}

/** One session in the popover: glyph, title, writer, observers — dimmed with its reason once ended. */
function DeckCard({
  session,
  title,
  active,
  reason,
  onSelect,
  onKill,
}: {
  session: DeckSession;
  title: string;
  active: boolean;
  reason?: string;
  onSelect: () => void;
  onKill?: () => void;
}) {
  const glyph = glyphFor(session.command);
  const observers = observerCount(session);
  return (
    <button
      type="button"
      className={cx("deck-card", active && "is-active", !session.live && "is-ended")}
      data-testid={`deck-card-${session.name}`}
      onClick={onSelect}
    >
      <span className={`deck-card__glyph deck-card__glyph--${glyph}`} aria-hidden>
        {GLYPH_MARKS[glyph]}
      </span>
      <span className="deck-card__body">
        <span className="deck-card__title">{title}</span>
        {!session.live && <span className="deck-card__reason">{reason ?? "ended"}</span>}
      </span>
      {!session.live && <span className="deck-card__state">ended</span>}
      {session.live && session.writerFde && <Avatar author={session.writerFde} />}
      {session.live && observers > 0 && <span className="deck-card__observers">+{observers}</span>}
      {onKill && (
        <span
          role="button"
          aria-label={`Close session ${session.name}`}
          className="deck-card__close"
          onClick={(event) => {
            event.stopPropagation();
            onKill();
          }}
        >
          ×
        </span>
      )}
    </button>
  );
}

function DeckSkew({ side }: { side: SkewSide }) {
  const card = skewCard(side);
  return (
    <div className="deck-pop__skew" data-testid="deck-skew">
      <span className="deck-pop__skew-title">{card.title}</span>
      <span className="deck-pop__skew-detail">{card.detail}</span>
    </div>
  );
}

/**
 * The slim context bar above the full-bleed stage — the explicit, always-visible way
 * back: chevron + room title returns to the conversation (⌘⇧L does the same), the
 * session's title says where you are, and the deck control rides along so switching
 * sessions never requires leaving. Room messages posted while attached badge the
 * back affordance. Height matches viewer__bar so pane borders align.
 */
export function StageBar({
  roomTitle,
  sessionTitle,
  unread = 0,
  onBack,
  children,
}: {
  roomTitle: string;
  sessionTitle: string;
  unread?: number;
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="room-stage-bar" data-testid="room-stage-bar">
      <Tooltip content="Back to the conversation (⌘⇧L)">
        <button
          type="button"
          className="room-stage-bar__back"
          data-testid="stage-back"
          aria-label={`Back to ${roomTitle}`}
          onClick={onBack}
        >
          <CaretLeft size={14} />
          <span className="room-stage-bar__room">{roomTitle}</span>
          {unread > 0 && (
            <span className="room-stage-bar__unread" data-testid="stage-unread">
              {unread}
            </span>
          )}
        </button>
      </Tooltip>
      <span className="room-stage-bar__session" data-testid="stage-session">
        {sessionTitle}
      </span>
      {children}
    </div>
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

/** The demo/browser stand-in for a live attach: the deck is data, terminals are the app's. */
export function DeckAttachUnavailable({ session }: { session: string }) {
  return (
    <div className="room-deck-card" data-testid="deck-attach-unavailable">
      <div className="room-deck-card__title">{session}</div>
      <div className="room-deck-card__reason">Terminals attach in the Mast app.</div>
    </div>
  );
}
