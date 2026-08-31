import { useState } from "react";
import { Avatar } from "../components/Avatar";
import { ContextMenu } from "../components/ContextMenu";
import { cx } from "../components/cx";
import { IconButton } from "../components/IconButton";
import { Terminal } from "../components/icons";
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
 * The room deck's presentation: a strip of session chips under the room header, the
 * open-terminal verb with its agent picker, and the ended-session card. Pure props in,
 * callbacks out — the panel owns data and the Tauri edge owns attaching.
 */

const GLYPH_MARKS: Record<DeckGlyph, string> = { claude: "✳", codex: "◆", shell: "❯" };

const PICKER: Array<{ glyph: DeckGlyph; label: string }> = [
  { glyph: "shell", label: "Shell" },
  { glyph: "claude", label: "Claude Code" },
  { glyph: "codex", label: "Codex" },
];

export function DeckStrip({
  sessions,
  roomId,
  titles = {},
  selected,
  skew,
  onSelect,
  onClose,
  onOpen,
}: {
  sessions: DeckSession[];
  roomId: string;
  /** Live OSC titles by session name, from panes attached in this app. */
  titles?: Record<string, string>;
  selected?: string | null;
  /** A pty handshake skew replaces the chips — the listing itself is unknowable. */
  skew?: SkewSide | null;
  onSelect: (name: string) => void;
  onClose?: (session: DeckSession) => void;
  onOpen: (glyph: DeckGlyph) => void;
}) {
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  if (skew) {
    const card = skewCard(skew);
    return (
      <div className="room-deck room-deck--skew" data-testid="room-deck">
        <span className="room-deck__skew-title">{card.title}</span>
        <span className="room-deck__skew-detail">{card.detail}</span>
      </div>
    );
  }

  return (
    <div className="room-deck" data-testid="room-deck">
      {sessions.map((session) => {
        const glyph = glyphFor(session.command);
        const observers = observerCount(session);
        return (
          <button
            key={session.name}
            type="button"
            className={cx(
              "room-deck__chip",
              selected === session.name && "is-active",
              !session.live && "is-ended",
            )}
            data-testid={`deck-chip-${session.name}`}
            onClick={() => onSelect(session.name)}
          >
            <span className={`room-deck__glyph room-deck__glyph--${glyph}`} aria-hidden>
              {GLYPH_MARKS[glyph]}
            </span>
            <span className="room-deck__title">{chipTitle(session, roomId, titles[session.name])}</span>
            {!session.live && <span className="room-deck__state">ended</span>}
            {session.live && session.writerFde && <Avatar author={session.writerFde} />}
            {session.live && observers > 0 && (
              <span className="room-deck__observers">+{observers}</span>
            )}
            {onClose && (
              <span
                role="button"
                aria-label={`Close session ${session.name}`}
                className="room-deck__close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session);
                }}
              >
                ×
              </span>
            )}
          </button>
        );
      })}
      <IconButton
        label="Open terminal"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPicker({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <Terminal size={15} />
      </IconButton>
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
