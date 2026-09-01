import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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
const noop = () => {};

export interface RoomTerminalProps {
  readonly session: string;
  readonly project: string;
  readonly room: string;
  /** argv to create the session with when it does not exist on the host. */
  readonly command: string[];
  /** Kill the corpse first — the ended-card revive flow re-minting the same name. */
  readonly killFirst?: boolean;
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
    killFirst,
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
  // The revive flow: clear the corpse before the pane's create-then-attach runs.
  const [ready, setReady] = useState(!killFirst);
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

  useEffect(() => {
    if (!killFirst) return;
    let cancelled = false;
    void invoke("session_kill", { socketPath: NODE_SOCKET, token: "", session })
      .catch(noop)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [killFirst, session]);

  if (!ready) return <div className="room-terminal" />;

  const observing = !!writer && !!me && writer !== me;
  return (
    <div className="room-terminal">
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
