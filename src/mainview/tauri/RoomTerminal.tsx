import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { DeckServices, RoomTerminalProps } from "../terminal/roomDeck";
import { SessionTerminalPane, type TerminalHandle } from "./SessionTerminalPane";

/**
 * The room deck's attach surface: the shipped durable terminal pane, created
 * room-bound in the project's container, with the observer banner on top. When
 * another FDE holds the write token you join watching; Take write claims it and
 * the host's WriterChanged broadcast moves the banner for everyone.
 */

const NODE_SOCKET = "~/.sail/pty.sock";
const noop = () => {};

function RoomTerminal({
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
}: RoomTerminalProps) {
  // The revive flow: clear the corpse before the pane's create-then-attach runs.
  const [ready, setReady] = useState(!killFirst);
  const [writer, setWriter] = useState(writerFde ?? "");
  const paneRef = useRef<TerminalHandle>(null);

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
      />
    </div>
  );
}

export const tauriDeckServices: DeckServices = { Terminal: RoomTerminal };
