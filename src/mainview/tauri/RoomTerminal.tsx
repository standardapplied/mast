import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import type { MenuNode } from "../components/ContextMenu";
import type { SessionStatus } from "../terminal/connection";
import { SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

/**
 * One room-bound pane in the route's workbench: the shipped durable terminal
 * pane, created in the project's container and admitted to the room, with the
 * observer banner on top. When another FDE holds the write token you join
 * watching; Take write claims it and the host's WriterChanged broadcast moves
 * the banner for everyone.
 */

const NODE_SOCKET = "~/.sail/pty.sock";

export interface RoomTerminalProps {
  readonly session: string;
  readonly project: string;
  readonly room: string;
  /** argv to create the session with when it does not exist on the host. */
  readonly command: string[];
  /** A refused close for this session, rendered inline where the pane lives. */
  readonly refusal?: string;
  readonly active: boolean;
  readonly visible: boolean;
  /** The caller's FDE, to tell "I hold write" from "someone else does". */
  readonly me?: string;
  /** The write holder as last listed, seeding the banner before any writer event. */
  readonly writerFde?: string;
  readonly onStatus?: (status: SessionStatus) => void;
  readonly onTitle?: (title: string) => void;
  /** Extra context-menu entries (the pane host's rename/color/close). */
  readonly menuExtras?: MenuNode[];
}

export const RoomTerminal = forwardRef<TerminalHandle, RoomTerminalProps>(function RoomTerminal(
  {
    session,
    project,
    room,
    command,
    refusal,
    active,
    visible,
    me,
    writerFde,
    onStatus,
    onTitle,
    menuExtras,
  },
  ref,
) {
  const [writer, setWriter] = useState(writerFde ?? "");
  const paneRef = useRef<TerminalHandle>(null);

  useImperativeHandle(
    ref,
    () => ({
      paste: (text: string) => paneRef.current?.paste(text),
      refit: () => paneRef.current?.refit(),
      revive: () => paneRef.current?.revive?.(),
      takeWrite: () => paneRef.current?.takeWrite?.(),
    }),
    [],
  );

  const observing = !!writer && !!me && writer !== me;
  return (
    <div className="room-terminal">
      {refusal && (
        <div className="room-terminal__refusal" data-testid={`refusal-${session}`}>
          Close refused — {refusal}
        </div>
      )}
      {observing && (
        <div className="room-terminal__banner" data-testid="observer-banner">
          <span>{writer} holds write — you are observing</span>
          <button
            type="button"
            className="term-overlay__btn"
            onClick={() => paneRef.current?.takeWrite?.()}
          >
            Take write
          </button>
        </div>
      )}
      <SessionTerminalPane
        ref={paneRef}
        socketPath={NODE_SOCKET}
        token=""
        session={session}
        create={{ command, cwd: "~", project, room, cols: 80, rows: 24 }}
        active={active}
        visible={visible}
        onStatus={onStatus}
        onTitle={onTitle}
        onWriter={setWriter}
        menuExtras={menuExtras}
      />
    </div>
  );
});
