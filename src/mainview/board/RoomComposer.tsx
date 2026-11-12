import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { FdeView, RoomMemberView } from "../../shared/sail-models";
import { cx } from "../components/cx";
import { DropdownPanel } from "../components/DropdownPanel";
import { Send } from "../components/icons";
import { Textarea } from "../components/Textarea";
import { Tooltip } from "../components/Tooltip";
import { catalogStore } from "./catalogStore";
import { AGENT_MENTION, insertMention, mentionQuery } from "./mentions";
import { roomDrafts } from "./roomDrafts";

const OFFERED = 5;

type Mentionable = { handle: string; name: string };

/** Who `@` offers in a room: its project's people but you, then its agent members under the one
 *  handle sail wakes an agent by. */
function mentionables(people: FdeView[], members: RoomMemberView[], me?: string): Mentionable[] {
  return [
    ...people
      .filter((person) => person.handle !== me)
      .map((person) => ({ handle: person.handle, name: person.display_name || person.handle })),
    ...members.map((member) => ({
      handle: AGENT_MENTION,
      name: member.agent_name ?? member.agent,
    })),
  ];
}

function matches(candidate: Mentionable, query: string): boolean {
  const typed = query.toLowerCase();
  return [candidate.handle, ...candidate.name.split(/\s+/)].some((word) =>
    word.toLowerCase().startsWith(typed),
  );
}

/**
 * Where a room is written to: the room's draft, kept in {@link roomDrafts} so it outlives a room
 * switch or a restart, and a mention list that `@` opens. Enter sends and Shift+Enter breaks the
 * line; while the list is open, the arrows choose, Enter or Tab inserts and Escape closes it.
 */
export function RoomComposer({
  roomId,
  onSend,
}: {
  roomId: string;
  onSend: (body: string) => void;
}) {
  const draft = useSyncExternalStore(roomDrafts.subscribe, () => roomDrafts.draft(roomId));
  useSyncExternalStore(catalogStore.subscribe, () => catalogStore.version);
  useEffect(() => catalogStore.retainPeople(), []);
  const [caret, setCaret] = useState<number | null>(null);
  const [choice, setChoice] = useState({ query: "", index: 0 });
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const placeCaret = useRef<number | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const listId = useId();
  const me = catalogStore.me;

  const roster = catalogStore.people();
  const candidates = mentionables(
    roster.state === "loaded" ? roster.fdes : [],
    catalogStore.roomOf(roomId)?.members ?? [],
    me,
  );
  const query = caret === null ? null : mentionQuery(draft, caret);
  const offered =
    query && query.start !== dismissedAt
      ? candidates.filter((candidate) => matches(candidate, query.query)).slice(0, OFFERED)
      : [];
  const open = query !== null && offered.length > 0;
  const typed = query?.query ?? "";
  const active = open && choice.query === typed ? choice.index % offered.length : 0;
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    if (placeCaret.current === null || !textarea.current) return;
    textarea.current.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  });

  useLayoutEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [open, active, typed]);

  const write = (text: string, at: number) => {
    roomDrafts.keep(roomId, text);
    setCaret(at);
    setDismissedAt(null);
  };

  const insert = (candidate: Mentionable) => {
    if (!query || caret === null) return;
    const next = insertMention(draft, caret, query.start, candidate.handle);
    placeCaret.current = next.caret;
    write(next.text, next.caret);
    textarea.current?.focus();
  };

  const send = () => {
    if (!draft.trim()) return;
    onSend(draft);
    write("", 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open) {
      const step =
        event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? offered.length - 1 : null;
      if (step !== null) {
        event.preventDefault();
        return setChoice({ query: typed, index: (active + step) % offered.length });
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        return insert(offered[active]!);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return setDismissedAt(query.start);
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  return (
    <div className="room-composer" ref={composer}>
      <Textarea
        ref={textarea}
        value={draft}
        maxLength={65_536}
        autoGrow
        rows={1}
        placeholder="Message this room…"
        aria-label="Message this room"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        onChange={(event) => write(event.target.value, event.target.selectionStart)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setCaret(null)}
        onKeyDown={onKeyDown}
      />
      <DropdownPanel triggerRef={composer} isOpen={open}>
        <div
          className="option-list mention-options"
          role="listbox"
          id={listId}
          aria-label="Mention someone"
        >
          {offered.map((candidate, index) => (
            <div
              key={index}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={cx("option", index === active && "is-active")}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setChoice({ query: typed, index })}
              onClick={() => insert(candidate)}
            >
              <span className="option-body">
                <span className="option-label">{candidate.name}</span>
                <span className="option-description">@{candidate.handle}</span>
              </span>
            </div>
          ))}
        </div>
      </DropdownPanel>
      <div className="room-composer-row">
        <span className="room-composer-hint">shift + enter for new line · @ to mention</span>
        <Tooltip content="Send">
          <button
            type="button"
            className="room-send"
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={send}
          >
            <Send size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
