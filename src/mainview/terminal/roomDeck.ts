import type { ComponentType } from "react";
import type { SailEvent } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import { labelFor, nextSessionName } from "./paneLayout";

/**
 * The room deck's model: which of a host's pty sessions belong to a room, what each
 * card says (glyph, title, writer, observers), how room sessions are named, what a
 * route pane does with a session (attach vs the ended card), and how a SAILPTY
 * version skew or a dispatch yield reads. Pure data + functions — the deck
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

/**
 * A session as the store's inventory holds it: the listing truth plus the
 * store's own transitions — a create not yet listed, a kill in flight, and a
 * mutation the box refused, rendered inline where the click happened.
 */
export type SessionEntry = DeckSession & {
  readonly pending?: boolean;
  readonly dying?: boolean;
  readonly refusal?: string;
};

/**
 * An observed death: a local kill ack, a pty_session_ended event, or a listing
 * that dropped a previously-live name. Layout reconcile may recreate an absent
 * session ONLY when no record exists (the genuine host-restart case); `command`
 * is what ran, kept so a revive can re-mint it.
 */
export type DeathRecord = {
  readonly reason: string;
  readonly at: number;
  readonly command?: string[];
};

export type DeckGlyph = "claude" | "codex" | "shell";

/** The mark a glyph draws on cards, picker rows, and inventory rows. */
export const GLYPH_MARKS: Record<DeckGlyph, string> = { claude: "✳", codex: "◆", shell: "❯" };

/** What ＋ (and the Actions submenu) can launch in a room, in menu order. */
export const DECK_LAUNCHERS: ReadonlyArray<{ glyph: DeckGlyph; label: string }> = [
  { glyph: "shell", label: "Shell" },
  { glyph: "claude", label: "Claude Code" },
  { glyph: "codex", label: "Codex" },
];

/** A navigation to the room's terminal route: where it is and what to do on entry. */
export type RoomTerminalRequest = {
  readonly roomId: string;
  readonly project: string;
  /** The room's display title, carried on the route bar's back affordance. */
  readonly title: string;
  /** Focus this session on entry (a deck card was clicked). */
  readonly focus?: string;
  /** Open a fresh session of this glyph on entry (Actions ▸ Open terminal ▸ …). */
  readonly launch?: DeckGlyph;
};

/** The full-screen room workbench; injected by the Tauri entry only. */
export type RoomWorkbenchProps = {
  readonly gateway: Gateway;
  readonly roomId: string;
  readonly project: string;
  /** False while the route is hidden — parks terminal focus and drawing. */
  readonly active: boolean;
  readonly focus?: string;
  readonly launch?: DeckGlyph;
};

export type DeckServices = {
  readonly Workbench: ComponentType<RoomWorkbenchProps>;
};

/** What a route pane the client opened (or revived) attaches with. */
export type LaunchSpec = {
  readonly command: string[];
  /** Kill the corpse first — the ended-card revive flow re-minting the same name. */
  readonly killFirst?: boolean;
};

/**
 * What a route pane shows for a session. Explicit launches attach with their picked
 * command; a live listed session attaches with the command it runs; a session absent
 * from the host entirely (reboot, pruned) is recreated in place as a plain shell —
 * the Terminal view's layout-survives-a-reboot behavior, safe because no agent can
 * be displaced by a shell. An absent session the store watched die parks on the
 * ended card with the recorded reason — recreating it would undo the kill — and a
 * listed corpse parks the same way: recreating a dead agent session unasked could
 * put two agents on one checkout.
 */
export function panePlan(
  session: string,
  listed: readonly DeckSession[],
  launched: ReadonlyMap<string, LaunchSpec>,
  deaths?: ReadonlyMap<string, DeathRecord>,
):
  | { kind: "attach"; command: string[]; killFirst: boolean; writerFde?: string }
  | { kind: "ended"; restartCommand: string[] } {
  const listing = listed.find((s) => s.name === session);
  const opened = launched.get(session);
  if (opened) {
    return {
      kind: "attach",
      command: opened.command,
      killFirst: opened.killFirst ?? false,
      writerFde: listing?.writerFde,
    };
  }
  if (!listing) {
    const death = deaths?.get(session);
    if (death) return { kind: "ended", restartCommand: death.command ?? ["bash", "-l"] };
    return { kind: "attach", command: ["bash", "-l"], killFirst: false };
  }
  if (listing.live) {
    return { kind: "attach", command: listing.command, killFirst: false, writerFde: listing.writerFde };
  }
  return { kind: "ended", restartCommand: listing.command };
}

/** One room's sessions in the Terminal view's inventory. */
export type RoomSessionGroup<S extends DeckSession = DeckSession> = {
  readonly roomId: string;
  readonly title: string;
  readonly project: string;
  readonly sessions: S[];
};

/**
 * The Terminal view's "Rooms" inventory: every room-bound session grouped by room
 * (rooms in id order, the deck's live-first order inside), titled from the rooms
 * listing — an unknown room falls back to its id, never disappears from the
 * operator's whole-box inventory.
 */
export function roomGroups<S extends DeckSession>(
  all: readonly S[],
  rooms: ReadonlyArray<{ id: string; title: string; project: string }>,
): Array<RoomSessionGroup<S>> {
  const ids = [...new Set(all.filter((s) => s.room).map((s) => s.room))].sort();
  return ids.map((roomId) => {
    const room = rooms.find((r) => r.id === roomId);
    return {
      roomId,
      title: room?.title ?? roomId,
      project: room?.project ?? "",
      sessions: deckSessions(all, roomId),
    };
  });
}

/** The room's slice of the host listing: live sessions first, stable name order inside. */
export function deckSessions<S extends DeckSession>(all: readonly S[], roomId: string): S[] {
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

/**
 * Classifies a pre-attach failure (the session listing or open threw before any
 * session existed): a protocol skew is a refusal to park on — retrying can only
 * fail the same way until one side is upgraded — while anything else is the link
 * and reattaches on the usual backoff.
 */
export function preAttachClass(message: string): "refused" | "transport" {
  return skewOf(message) ? "refused" : "transport";
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

/** True for any session-lifecycle event — the session store's refresh cue. */
export function isPtyEvent(event: SailEvent): boolean {
  return PTY_EVENT_TYPES.has(event.type);
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
