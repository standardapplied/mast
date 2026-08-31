import type { ComponentType } from "react";
import type { SailEvent } from "../../shared/sail-models";
import type { SessionStatus } from "./connection";
import { labelFor, nextSessionName } from "./paneLayout";

/**
 * The room deck's model: which of a host's pty sessions belong to a room, what each
 * chip says (glyph, title, writer, observers), how room sessions are named, and how
 * a SAILPTY version skew or a dispatch yield reads. Pure data + functions — the deck
 * components and the Tauri terminal edge are thin skins over these.
 */

/** One session as `session_list` returns it (the SAILPTY2 SessionInfo, camelCased). */
export type DeckSession = {
  readonly name: string;
  readonly live: boolean;
  readonly attached: number;
  readonly writerFde: string;
  readonly room: string;
  readonly command: string[];
};

export type DeckGlyph = "claude" | "codex" | "shell";

/** The terminal picks a room's sessions attach into; injected by the Tauri entry only. */
export type RoomTerminalProps = {
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
};

export type DeckServices = {
  readonly Terminal: ComponentType<RoomTerminalProps>;
};

/** The room's slice of the host listing: live sessions first, stable name order inside. */
export function deckSessions(all: readonly DeckSession[], roomId: string): DeckSession[] {
  return all
    .filter((s) => s.room === roomId)
    .sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
}

/** What ran in the session, by the requested argv's executable basename. */
export function glyphFor(command: readonly string[]): DeckGlyph {
  const executable = command[0]?.split("/").pop() ?? "";
  if (executable.startsWith("claude")) return "claude";
  if (executable.startsWith("codex")) return "codex";
  return "shell";
}

export function commandFor(glyph: DeckGlyph): string[] {
  switch (glyph) {
    case "claude":
      return ["claude"];
    case "codex":
      return ["codex"];
    case "shell":
      return ["bash", "-l"];
  }
}

/** The session `sail agent attach` opens for a run's resumed conversation. */
export function isResumeSession(name: string): boolean {
  return name.startsWith("resume-");
}

export function roomSessionBase(roomId: string): string {
  return `room-${roomId}`;
}

/** The next free room-session name: `room-<id>`, then `room-<id>.2` upward. */
export function nextRoomSession(roomId: string, taken: Iterable<string>): string {
  return nextSessionName(taken, roomSessionBase(roomId));
}

/** A chip's display name: the live OSC title, else resume identity, else the ordinal. */
export function chipTitle(session: DeckSession, roomId: string, oscTitle?: string): string {
  if (oscTitle) return oscTitle;
  if (isResumeSession(session.name)) return session.name;
  return labelFor(session.name, roomSessionBase(roomId));
}

/** Subscribers beyond the writer; everyone when no one holds write. */
export function observerCount(session: DeckSession): number {
  return Math.max(0, session.attached - (session.writerFde ? 1 : 0));
}

/* ------------------------------- version skew ------------------------------- */

export type SkewSide = "box-older" | "mast-older";

/**
 * Reads the Rust handshake's skew reason (see SKEW_* in src-tauri/src/pty.rs). A
 * SAILPTY1 echo means the box's sail predates this Mast; any other mismatch means
 * the box has moved past the protocol this Mast speaks.
 */
export function skewOf(reason: string | undefined): SkewSide | null {
  if (!reason?.includes("pty protocol skew")) return null;
  return reason.includes("SAILPTY1") ? "box-older" : "mast-older";
}

export function skewCard(side: SkewSide): { title: string; detail: string } {
  return side === "box-older"
    ? {
        title: "This box's sail is older than Mast",
        detail: "Run sail upgrade on the box, then reconnect.",
      }
    : {
        title: "This Mast is older than the box",
        detail: "Update Mast from the user menu, then reconnect.",
      };
}

/* ------------------------------- room events ------------------------------- */

const PTY_EVENT_TYPES = new Set([
  "pty_session_started",
  "pty_session_attached",
  "pty_session_ended",
]);

/** True when a live event should refresh this room's deck. */
export function isDeckEvent(event: SailEvent, roomId: string): boolean {
  return (
    PTY_EVENT_TYPES.has(event.type) &&
    (event.spec === roomId || event.data?.room_id === roomId)
  );
}

/** Each session's last recorded ended reason, from the room's pty event history. */
export function endedReasons(events: readonly SailEvent[]): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const event of events) {
    if (event.type !== "pty_session_ended") continue;
    const session = event.data?.session;
    const reason = event.data?.reason;
    if (typeof session === "string" && typeof reason === "string") {
      reasons[session] = reason;
    }
  }
  return reasons;
}

/** The dispatch a yield notice names, when the reason is a dispatch displacement. */
export function yieldedDispatch(
  reason: string | undefined,
): { runId: string; specId?: string } | null {
  const match = reason?.match(/^yielded to dispatch (\S+)(?: of spec (\S+))?$/);
  if (!match) return null;
  return { runId: match[1]!, ...(match[2] ? { specId: match[2] } : {}) };
}
