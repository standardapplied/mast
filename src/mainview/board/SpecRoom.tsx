import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import type {
  EngagementView,
  Finding,
  ReviewDetailResponse,
  ReviewView,
  RunView,
  SailEvent,
} from "../../shared/sail-models";
import { Avatar } from "../components/Avatar";
import { Logo, Send, Spinner } from "../components/icons";
import { LoadingMark } from "../components/Loading";
import { Textarea } from "../components/Textarea";
import { Tooltip } from "../components/Tooltip";
import { useToast } from "../components/Toast";
import { Badge, Button, type BadgeTone } from "../components/ui";
import type { Gateway } from "../gateway";
import {
  hasWritten,
  liveTurns,
  NO_LIVE_TURNS,
  revealLiveTurns,
  settleLiveTurns,
  showsWorking,
  streamGapped,
  takingADraftsPlace,
  type Draft,
  type LiveTurns,
} from "./liveTurns";
import { presenceStore, type PresenceStore } from "./presenceStore";
import { Markdown } from "../markdown";
import { coalesce, isTelemetryEvent, roomRefreshFor } from "./roomRouting";
import { SnapshotsPanel } from "./SnapshotsPanel";
import {
  assembleTimeline,
  eventActor,
  eventNarration,
  groupTimeline,
  mergeMessages,
  type BufferedTail,
  type RoomMessage,
  type TimelineDecision,
  type TimelineItem,
} from "./specTimeline";

const PAGE_SIZE = 100;
const SCROLL_EDGE_PX = 48;
const AT_LATEST_PX = 1;

const SEVERITY_TONE: Record<Finding["severity"], BadgeTone> = {
  CRITICAL: "error",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

type Sources = {
  messages: RoomMessage[];
  events: SailEvent[];
  reviews: ReviewDetailResponse[];
  runs: RunView[];
  decisions: TimelineDecision[];
};

type TimelineUpdate = "replace" | "live" | "earlier";

const EMPTY_SOURCES: Sources = {
  messages: [],
  events: [],
  reviews: [],
  runs: [],
  decisions: [],
};

function findingLocation(finding: Finding): string | undefined {
  if (!finding.file) return undefined;
  if (finding.line_start <= 0) return finding.file;
  const range =
    finding.line_end > finding.line_start
      ? `${finding.line_start}–${finding.line_end}`
      : `${finding.line_start}`;
  return `${finding.file}:${range}`;
}

function eventKey(event: SailEvent): string {
  return event.id === undefined
    ? `${event.type}:${event.ts}:${event.agent}`
    : `event:${event.id}`;
}

function mergeEvents(existing: SailEvent[], incoming: SailEvent[]): SailEvent[] {
  const byId = new Map(existing.map((event) => [eventKey(event), event]));
  for (const event of incoming) byId.set(eventKey(event), event);
  return [...byId.values()].sort(
    (left, right) => left.ts.localeCompare(right.ts) || eventKey(left).localeCompare(eventKey(right)),
  );
}

/**
 * Drops the optimistic decision a server-confirmed {@code review_approved} / {@code
 * finding_dismissed} event supersedes. Shared by the live handler and the reconnect gap-fill so a
 * confirmation that lands during a disconnect clears the optimistic overlay just like a live one.
 */
function reconcileDecisions(decisions: TimelineDecision[], event: SailEvent): TimelineDecision[] {
  if (event.type !== "review_approved" && event.type !== "finding_dismissed") return decisions;
  const action = event.type === "review_approved" ? "approved" : "dismissed";
  const reviewId = event.data?.review_id;
  const findingId = event.data?.finding_id;
  return decisions.filter(
    (candidate) =>
      candidate.action !== action ||
      candidate.reviewId !== reviewId ||
      candidate.findingId !== findingId,
  );
}

function reconcileTimeline(
  previous: BufferedTail<TimelineItem>,
  next: TimelineItem[],
  update: TimelineUpdate,
  atLatest: boolean,
): BufferedTail<TimelineItem> {
  if (previous.visible.length === 0 && previous.buffered.length === 0) {
    return { visible: next.slice(-PAGE_SIZE), buffered: [] };
  }
  const visibleIds = new Set(previous.visible.map((item) => item.id));
  const bufferedIds = new Set(previous.buffered.map((item) => item.id));
  const knownIds = new Set([...visibleIds, ...bufferedIds]);
  const fresh = next.filter((item) => !knownIds.has(item.id));
  if (update === "replace" || (update === "live" && atLatest)) {
    return { visible: next, buffered: [] };
  }
  if (update === "earlier") {
    return {
      visible: next.filter((item) => visibleIds.has(item.id) || !knownIds.has(item.id)),
      buffered: next.filter((item) => bufferedIds.has(item.id)),
    };
  }
  return {
    visible: next.filter((item) => visibleIds.has(item.id)),
    buffered: next.filter((item) => bufferedIds.has(item.id) || fresh.includes(item)),
  };
}

function fromLatest(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function byOccurrence(left: TimelineItem, right: TimelineItem): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

/** Brings the named messages out from behind the pill, to where the reader is reading. */
function inPlace(
  tail: BufferedTail<TimelineItem>,
  messageIds: readonly string[],
): BufferedTail<TimelineItem> {
  const named = (item: TimelineItem) =>
    item.kind === "message" && messageIds.includes(item.message.id);
  if (!tail.buffered.some(named)) return tail;
  return {
    visible: [...tail.visible, ...tail.buffered.filter(named)].sort(byOccurrence),
    buffered: tail.buffered.filter((item) => !named(item)),
  };
}

/** Brings everything out from behind the pill: the reader is at the latest. */
function released(tail: BufferedTail<TimelineItem>): BufferedTail<TimelineItem> {
  if (tail.buffered.length === 0) return tail;
  return { visible: [...tail.visible, ...tail.buffered].sort(byOccurrence), buffered: [] };
}

function dayOf(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : `${parsed.getFullYear()}-${parsed.getMonth()}-${parsed.getDate()}`;
}

function dayLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(parsed);
}

function dateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  const today = new Date();
  const sameDay =
    parsed.getFullYear() === today.getFullYear() &&
    parsed.getMonth() === today.getMonth() &&
    parsed.getDate() === today.getDate();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function authorLabel(author: string, runs: RunView[]): string {
  const run = runs.find((candidate) => candidate.principal === author);
  if (run) return run.owner ? `${run.agent} (for ${run.owner})` : run.agent;
  return author.includes("/") ? author.split("/")[0]! : author;
}

function eventDetail(event: SailEvent): string {
  const source = event.data?.source;
  const exitCode = event.data?.exit_code;
  const from = event.data?.from;
  const to = event.data?.to;
  return [
    typeof from === "string" && typeof to === "string" && `${from} → ${to}`,
    typeof source === "string" && source,
    typeof exitCode === "number" && `exit ${exitCode}`,
    eventNarration(event),
  ]
    .filter(Boolean)
    .join(" · ");
}

function TurnCutShort({ reason }: { reason: string }) {
  return (
    <p className="room-turn-cut-short">
      the agent's turn ended early{reason ? ` · ${reason}` : ""}
    </p>
  );
}

function TypingDots({ name }: { name: string }) {
  return (
    <span className="typing-dots" aria-label={name + " is typing"}>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * A turn as it is written: the member's row, with the text so far, a line per tool step, and
 * the dots while it says its member is working. The text is the box's payload drawn as text,
 * never as Markdown; the message it becomes is what gets rendered.
 */
function DraftRow({ draft, label }: { draft: Draft; label: string }) {
  const cutShort = draft.ended?.isError ? draft.ended : undefined;
  return (
    <article
      className="room-message-group room-draft"
      data-testid={`draft-${draft.runId}-${draft.turn}`}
    >
      <Avatar author={draft.principal} agent />
      <div className="room-message-content">
        <header className="room-message-head">
          <strong>{label}</strong>
        </header>
        {draft.text && (
          <div className={`room-message-body room-draft-text${cutShort ? " is-cut-short" : ""}`}>
            {draft.text}
          </div>
        )}
        {draft.tools.length > 0 && (
          <ul className="room-draft-tools">
            {draft.tools.map((line, index) => (
              <li key={index} className={line.running ? "is-running" : undefined}>
                <span>{line.tool}</span>
                <span className="room-draft-tool-summary">{line.summary}</span>
                <span className="room-draft-tool-status">{line.running ? "running" : "done"}</span>
              </li>
            ))}
          </ul>
        )}
        {showsWorking(draft) && <TypingDots name={label} />}
        {cutShort && <TurnCutShort reason={cutShort.reason} />}
      </div>
    </article>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className="finding-row" data-testid={`finding-${finding.id}`}>
      <div className="finding-head">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity.toLowerCase()}</Badge>
        <span className="finding-title">{finding.title}</span>
        {finding.resolution !== "OPEN" && (
          <span className="eyebrow finding-resolution">{finding.resolution.toLowerCase()}</span>
        )}
      </div>
      <span className="finding-meta">
        {finding.category}
        {findingLocation(finding) ? ` · ${findingLocation(finding)}` : ""}
      </span>
      <p className="finding-desc">{finding.description}</p>
      {finding.suggestion?.rationale && (
        <p className="finding-suggestion">{finding.suggestion.rationale}</p>
      )}
    </div>
  );
}

export function SpecRoom({
  gateway,
  specId,
  roomId = specId,
  specStatus,
  specTitle,
  canWrite,
  currentUser,
  engagement,
}: {
  gateway: Gateway;
  specId: string;
  /** The conversation's room; defaults to the spec id for pre-decouple identity rooms. */
  roomId?: string;
  specStatus?: string;
  specTitle?: string;
  canWrite: boolean;
  currentUser?: string;
  /** The room's standing agent, when one is engaged; drives the typing indicator. */
  engagement?: EngagementView;
}) {
  const [tail, setTail] = useState<BufferedTail<TimelineItem>>({
    visible: [],
    buffered: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<LiveTurns>(NO_LIVE_TURNS);
  const [repliesUnseen, setRepliesUnseen] = useState(0);
  const [expandedReviews, setExpandedReviews] = useState<Set<string>>(new Set());
  const [snapshotsProject, setSnapshotsProject] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sources = useRef<Sources>(EMPTY_SOURCES);
  const liveNow = useRef<LiveTurns>(NO_LIVE_TURNS);
  const tailDrawn = useRef(tail);
  const atLatest = useRef(true);
  const scrolledTo = useRef(0);
  const posting = useRef(false);
  const deferredMessageEvents = useRef<Set<string>>(new Set());
  const expectedMessageEvents = useRef<Set<string>>(new Set());
  const loadVersion = useRef(0);
  const { showToast } = useToast();

  /**
   * Every change to the live turns is settled against the messages the room holds, in the
   * render that shows them: a draft the reader can see leaves in the render its message is
   * drawn in, where the draft was, so they never see neither. A reader who is away is told of
   * it by the pill, as of any message that arrives while they are; one already drawn before they
   * left is not news.
   */
  const advanceLive = useCallback((step: (state: LiveTurns) => LiveTurns) => {
    const stepped = step(liveNow.current);
    const taking = takingADraftsPlace(stepped, sources.current.messages);
    const next = settleLiveTurns(stepped, sources.current.messages);
    if (next === liveNow.current) return;
    liveNow.current = next;
    setLive(next);
    if (taking.length === 0) return;
    setTail((previous) => inPlace(previous, taking));
    if (atLatest.current) return;
    const seen = tailDrawn.current.visible;
    const news = taking.filter(
      (id) => !seen.some((item) => item.kind === "message" && item.message.id === id),
    );
    setRepliesUnseen((unseen) => unseen + news.length);
  }, []);

  /**
   * Every message enters the room here, so here the live turns are settled against them: a
   * draft yields to its message however the room came to hold it.
   */
  const applySources = useCallback((next: Sources, update: TimelineUpdate) => {
    sources.current = next;
    const timeline = assembleTimeline(next);
    setTail((previous) => reconcileTimeline(previous, timeline, update, atLatest.current));
    advanceLive((state) => state);
  }, [advanceLive]);

  /** A reader who returns to the latest has nothing behind the pill, however they came back. */
  const follow = useCallback((latest: boolean) => {
    const returned = latest && !atLatest.current;
    atLatest.current = latest;
    if (!returned) return;
    advanceLive(revealLiveTurns);
    setTail(released);
    setRepliesUnseen(0);
  }, [advanceLive]);

  /**
   * In the frame after the room drew, a reader who still follows is taken to the latest, and
   * that move is remembered so their next one is told from it. One who has left by then is let
   * be, and a room that is not on screen has no place to keep.
   */
  const keepPlace = useCallback(() => {
    requestAnimationFrame(() => {
      const element = scroller.current;
      if (!element || element.clientHeight === 0 || !atLatest.current) return;
      element.scrollTop = element.scrollHeight;
      scrolledTo.current = element.scrollTop;
    });
  }, []);

  const loadReviewDetails = useCallback(
    async (reviews: ReviewView[]): Promise<ReviewDetailResponse[]> => {
      const details = await Promise.all(reviews.map((review) => gateway.reviewDetail(review.id)));
      return details.flatMap((result) => (result.ok ? [result.value] : []));
    },
    [gateway],
  );

  const loadEvents = useCallback(async (): Promise<SailEvent[] | null> => {
    const scoped = await gateway.specEvents(specId, { limit: PAGE_SIZE });
    if (scoped.ok) {
      // A decoupled room's pty lifecycle lands under the ROOM id, not the spec's —
      // fetch that lane too so terminal whispers survive the spec/room split.
      if (roomId === specId) return scoped.value.events;
      const roomScoped = await gateway.specEvents(roomId, { limit: PAGE_SIZE });
      return roomScoped.ok
        ? mergeEvents(scoped.value.events, roomScoped.value.events)
        : scoped.value.events;
    }
    const recent = await gateway.recentEvents(PAGE_SIZE);
    return recent.ok
      ? recent.value.events.filter((event) => event.spec === specId || event.spec === roomId)
      : null;
  }, [gateway, specId, roomId]);

  const loadRoom = useCallback(async (version: number) => {
    const [messages, events, runs] = await Promise.all([
      gateway.listSpecMessages(roomId, { limit: PAGE_SIZE }),
      loadEvents(),
      gateway.listRuns(specId),
    ]);
    if (version !== loadVersion.current) return;
    const base: Sources = {
      messages: messages.ok
        ? mergeMessages(messages.value.messages, sources.current.messages)
        : sources.current.messages,
      events: events ? mergeEvents(events, sources.current.events) : sources.current.events,
      reviews: sources.current.reviews,
      runs: runs.ok ? runs.value.runs : sources.current.runs,
      decisions: sources.current.decisions,
    };
    setHasEarlier(messages.ok && messages.value.messages.length === PAGE_SIZE);
    applySources(base, "replace");
    setLoading(false);

    const reviews = await gateway.specReviews(specId);
    if (version !== loadVersion.current) return;
    if (reviews.ok) {
      const details = await loadReviewDetails(reviews.value.reviews);
      if (version !== loadVersion.current) return;
      applySources({ ...sources.current, reviews: details }, "replace");
    }
  }, [applySources, gateway, loadEvents, loadReviewDetails, specId]);

  useEffect(() => {
    const version = ++loadVersion.current;
    sources.current = EMPTY_SOURCES;
    setTail({ visible: [], buffered: [] });
    setLoading(true);
    void loadRoom(version);
    return () => {
      if (loadVersion.current === version) loadVersion.current++;
    };
  }, [loadRoom]);

  const lastAgentReplyAt = useMemo(() => {
    if (!engagement) return null;
    const prefix = engagement.agent + "/";
    let newest: number | null = null;
    for (const item of [...tail.visible, ...tail.buffered]) {
      if (item.kind !== "message" || !item.message.author.startsWith(prefix)) continue;
      const at = Date.parse(item.occurredAt);
      if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
    }
    return newest;
  }, [engagement, tail]);

  const presenceVersion = useSyncExternalStore(
    (onChange) => presenceStore.subscribe(onChange),
    () => presenceStore.version,
  );
  const typing = useMemo(
    () =>
      engagement !== undefined &&
      typingVisible(presenceStore.chatPresenceOf(specId, Date.now()), lastAgentReplyAt),
    [engagement, specId, presenceVersion, lastAgentReplyAt],
  );

  /**
   * The room has just drawn, and the engine may have moved the reader to fit: a reply shorter
   * than its draft leaves them lower than they were. The scroll that tells of it comes a frame
   * later, when the end may have moved again, and would read as the reader moving up. So where
   * a layout leaves them is where their next move is told from, and a reader it leaves resting
   * at the very end follows. A move of the reader's own that no scroll has told of yet is taken
   * with it: an engine tells one within a frame, so at worst a single step made in the instant
   * before the room draws is undone once.
   */
  useLayoutEffect(() => {
    tailDrawn.current = tail;
    const element = scroller.current;
    if (!element || element.clientHeight === 0) return;
    scrolledTo.current = element.scrollTop;
    if (fromLatest(element) <= AT_LATEST_PX) follow(true);
  });

  useEffect(keepPlace, [keepPlace, tail.visible.length, typing, live]);

  useEffect(() => {
    advanceLive(() => NO_LIVE_TURNS);
    setRepliesUnseen(0);
    const stream = gateway.openRoomStream(roomId);
    const offEvent = stream.onEvent((event) => {
      if (event.spec === roomId) {
        advanceLive((state) => liveTurns(state, event, !atLatest.current));
      }
    });
    const offState = stream.onState((state) => {
      if (state === "reconnecting") advanceLive(streamGapped);
    });
    return () => {
      offEvent();
      offState();
      stream.stop();
    };
  }, [advanceLive, gateway, roomId]);

  const refreshMessages = useCallback(
    async (live: boolean) => {
      const result = await gateway.listSpecMessages(roomId, { limit: PAGE_SIZE });
      if (!result.ok) return;
      applySources(
        {
          ...sources.current,
          messages: mergeMessages(sources.current.messages, result.value.messages),
        },
        live ? "live" : "replace",
      );
    },
    [applySources, gateway, specId],
  );

  /**
   * Live catch-up: asks only for messages past the newest confirmed one. If an
   * announced message_id still isn't in the merge — a cross-node message can
   * sync in with an id older than the cursor — a recovery fetch anchored just
   * above the missing id's position (its loaded successor) reaches back to it.
   * The latest page would not: the missing message can sit below that window in
   * a busy room. The cursor is an optimization, never a correctness bet.
   */
  const fetchNewMessages = useCallback(async () => {
    const newest = sources.current.messages.findLast((message) => !message.delivery);
    if (!newest) return refreshMessages(true);
    const result = await gateway.listSpecMessages(roomId, {
      after: newest.id,
      limit: PAGE_SIZE,
    });
    if (!result.ok) return;
    applySources(
      {
        ...sources.current,
        messages: mergeMessages(sources.current.messages, result.value.messages),
      },
      "live",
    );
    const expected = expectedMessageEvents.current;
    expectedMessageEvents.current = new Set();
    const stillMissing = [...expected].filter(
      (id) => !sources.current.messages.some((message) => message.id === id),
    );
    if (stillMissing.length === 0) return;
    const oldestMissing = stillMissing.reduce((min, id) => (id < min ? id : min));
    const successor = sources.current.messages
      .map((message) => message.id)
      .filter((id) => id > oldestMissing)
      .reduce<string | undefined>(
        (min, id) => (min === undefined || id < min ? id : min),
        undefined,
      );
    const recovery = await gateway.listSpecMessages(
      specId,
      successor === undefined ? { limit: PAGE_SIZE } : { before: successor, limit: PAGE_SIZE },
    );
    if (!recovery.ok) return;
    applySources(
      {
        ...sources.current,
        messages: mergeMessages(sources.current.messages, recovery.value.messages),
      },
      "live",
    );
  }, [applySources, gateway, refreshMessages, specId]);

  const refreshRuns = useCallback(
    async (live: boolean) => {
      const runs = await gateway.listRuns(specId);
      if (!runs.ok) return;
      applySources({ ...sources.current, runs: runs.value.runs }, live ? "live" : "replace");
    },
    [applySources, gateway, specId],
  );

  const refreshReviews = useCallback(
    async (live: boolean) => {
      const reviews = await gateway.specReviews(specId);
      if (!reviews.ok) return;
      const details = await loadReviewDetails(reviews.value.reviews);
      applySources({ ...sources.current, reviews: details }, live ? "live" : "replace");
    },
    [applySources, gateway, loadReviewDetails, specId],
  );

  const refreshReviewDetail = useCallback(
    async (reviewId: string) => {
      if (!sources.current.reviews.some((detail) => detail.review.id === reviewId)) {
        return refreshReviews(true);
      }
      const result = await gateway.reviewDetail(reviewId);
      if (!result.ok) return;
      applySources(
        {
          ...sources.current,
          reviews: sources.current.reviews.map((detail) =>
            detail.review.id === reviewId ? result.value : detail,
          ),
        },
        "live",
      );
    },
    [applySources, gateway, refreshReviews],
  );

  const refreshReviewsAndRuns = useCallback(
    async (live: boolean) => {
      const [reviews, runs] = await Promise.all([
        gateway.specReviews(specId),
        gateway.listRuns(specId),
      ]);
      const details = reviews.ok
        ? await loadReviewDetails(reviews.value.reviews)
        : sources.current.reviews;
      applySources(
        {
          ...sources.current,
          reviews: details,
          runs: runs.ok ? runs.value.runs : sources.current.runs,
        },
        live ? "live" : "replace",
      );
    },
    [applySources, gateway, loadReviewDetails, specId],
  );

  useEffect(() => {
    const refreshers = {
      messages: coalesce(fetchNewMessages),
      reviews: coalesce(() => refreshReviews(true)),
      runs: coalesce(() => refreshRuns(true)),
      fallback: coalesce(() => refreshReviewsAndRuns(true)),
    };
    const detailRefreshers = new Map<string, () => void>();
    const refreshDetail = (reviewId: string) => {
      let kick = detailRefreshers.get(reviewId);
      if (!kick) {
        kick = coalesce(() => refreshReviewDetail(reviewId));
        detailRefreshers.set(reviewId, kick);
      }
      kick();
    };
    const off = gateway.onEvent((event) => {
      // The conversation spans two event lanes since the decouple: spec-scoped lifecycle
      // (runs, reviews) and room-scoped traffic (pty whispers, and messages — the server
      // scopes spec_message_posted to the HOME room, which differs from the spec id for a
      // spec born in another room). Accept both, exactly like the mount backfill does.
      if (event.spec !== specId && event.spec !== roomId) return;
      if (isTelemetryEvent(event.type)) return;
      if (event.type === "spec_message_posted") {
        const messageId =
          typeof event.data?.message_id === "string" ? event.data.message_id : undefined;
        if (messageId && sources.current.messages.some((message) => message.id === messageId)) return;
        if (posting.current && messageId) {
          deferredMessageEvents.current.add(messageId);
          return;
        }
        if (messageId) expectedMessageEvents.current.add(messageId);
        refreshers.messages();
        return;
      }
      applySources(
        {
          ...sources.current,
          events: mergeEvents(sources.current.events, [event]),
          decisions: reconcileDecisions(sources.current.decisions, event),
        },
        "live",
      );
      const refresh = roomRefreshFor(event);
      if (refresh.kind === "review-detail") refreshDetail(refresh.reviewId);
      else if (refresh.kind !== "none") refreshers[refresh.kind]();
    });
    return off;
  }, [
    applySources,
    fetchNewMessages,
    gateway,
    refreshReviewDetail,
    refreshReviews,
    refreshReviewsAndRuns,
    refreshRuns,
    specId,
    roomId,
  ]);

  const gapFill = useCallback(async () => {
    const version = loadVersion.current;
    // Event ids are globally monotonic, so the pre-drain maximum is the right watermark for
    // BOTH lanes — captured once, before either drain, so the first lane's newer ids can
    // never hide the second lane's backlog.
    const start = sources.current.events.reduce<number | undefined>(
      (max, event) =>
        event.id !== undefined && (max === undefined || event.id > max) ? event.id : max,
      undefined,
    );
    let sawMessage = false;
    let sawLifecycle = false;
    // The conversation spans two lanes since the decouple (see the live handler): the spec's
    // lifecycle and the home room's traffic. Drain each, paging until the server returns a
    // short page — a single request would silently drop every event past the first PAGE_SIZE
    // of a long disconnect.
    const lanes = roomId === specId ? [specId] : [specId, roomId];
    for (const lane of lanes) {
      let since = start;
      for (;;) {
        const result = await gateway.specEvents(
          lane,
          since === undefined ? { limit: PAGE_SIZE } : { since, limit: PAGE_SIZE },
        );
        if (!result.ok || version !== loadVersion.current) return;
        const batch = result.value.events;
        if (batch.length === 0) break;
        // Message events drive the message list, not the event timeline (as in the live
        // handler); lifecycle events merge into the timeline and reconcile optimistic
        // decisions.
        let decisions = sources.current.decisions;
        const lifecycle: SailEvent[] = [];
        for (const event of batch) {
          if (event.id !== undefined && (since === undefined || event.id > since)) since = event.id;
          if (event.type === "spec_message_posted") {
            sawMessage = true;
            continue;
          }
          sawLifecycle = true;
          lifecycle.push(event);
          decisions = reconcileDecisions(decisions, event);
        }
        applySources(
          { ...sources.current, events: mergeEvents(sources.current.events, lifecycle), decisions },
          "live",
        );
        if (batch.length < PAGE_SIZE) break;
      }
    }
    if (version !== loadVersion.current) return;
    // Gap-filled events must trigger the same durable refreshes the live handler runs, or the
    // message list, reviews, and runs stay stale until the next live event.
    if (sawMessage) void refreshMessages(true);
    if (sawLifecycle) void refreshReviewsAndRuns(true);
  }, [applySources, gateway, refreshMessages, refreshReviewsAndRuns, roomId, specId]);

  useEffect(() => {
    let previous: string | undefined;
    return gateway.onConnectionStatus((status) => {
      const reconnected =
        previous !== undefined && previous !== "connected" && status.stream === "connected";
      previous = status.stream;
      if (reconnected) void gapFill();
    });
  }, [gapFill, gateway]);

  const jumpToLatest = useCallback(() => {
    follow(true);
    keepPlace();
  }, [follow, keepPlace]);

  /**
   * A reader follows the latest until they move up, and again once they are back within reach
   * of it. A turn being written moves the latest many times a second, and a scroll is told
   * after it may have moved again, so the latest moving away is never the reader leaving; and
   * a reader who moves up at all has left, or the next delta would pull them back. Moving up
   * ends at the very latest only when what was below them shrank.
   */
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const movedUp = element.scrollTop < scrolledTo.current;
    scrolledTo.current = element.scrollTop;
    const latest = fromLatest(element) <= (movedUp ? AT_LATEST_PX : SCROLL_EDGE_PX);
    follow(latest || (atLatest.current && !movedUp));
  };

  const loadEarlier = async () => {
    const oldest = sources.current.messages.find((message) => !message.delivery);
    if (!oldest) return;
    setLoadingEarlier(true);
    const result = await gateway.listSpecMessages(roomId, {
      before: oldest.id,
      limit: PAGE_SIZE,
    });
    setLoadingEarlier(false);
    if (!result.ok) return showToast("error", result.error.message);
    setHasEarlier(result.value.messages.length === PAGE_SIZE);
    follow(false);
    applySources(
      {
        ...sources.current,
        messages: mergeMessages(sources.current.messages, result.value.messages),
      },
      "earlier",
    );
  };

  const replaceMessage = (id: string, replacement: RoomMessage) => {
    applySources(
      {
        ...sources.current,
        messages: sources.current.messages.map((message) =>
          message.id === id ? replacement : message,
        ),
      },
      "live",
    );
  };

  const submitMessage = async (message: RoomMessage) => {
    replaceMessage(message.id, { ...message, delivery: "pending", error: undefined });
    posting.current = true;
    const result = await gateway.postSpecMessage(roomId, { body: message.body });
    posting.current = false;
    if (!result.ok) {
      const failed = { ...message, delivery: "failed" as const, error: result.error.message };
      replaceMessage(message.id, failed);
      showToast("error", result.error.message);
      deferredMessageEvents.current.clear();
      return;
    }
    applySources(
      {
        ...sources.current,
        messages: mergeMessages(
          sources.current.messages.filter((candidate) => candidate.id !== message.id),
          [result.value.message],
        ),
      },
      "live",
    );
    const missed = [...deferredMessageEvents.current].some(
      (messageId) => messageId !== result.value.message.id,
    );
    deferredMessageEvents.current.clear();
    if (missed) void refreshMessages(true);
  };

  const send = () => {
    if (!canWrite || !draft.trim()) return;
    const message: RoomMessage = {
      id: `pending:${crypto.randomUUID()}`,
      spec_id: specId,
      author: currentUser ?? "you",
      body: draft,
      created_at: new Date().toISOString(),
      delivery: "pending",
    };
    setDraft("");
    follow(true);
    applySources(
      { ...sources.current, messages: mergeMessages(sources.current.messages, [message]) },
      "replace",
    );
    void submitMessage(message);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  const groups = groupTimeline(tail.visible);
  const behindPill =
    tail.buffered.length +
    live.drafts.filter((entry) => entry.behind && hasWritten(entry)).length +
    repliesUnseen;

  return (
    <div className="spec-room">
      {hasEarlier &&
        (loadingEarlier ? (
          <div className="room-load-earlier">
            <LoadingMark label="Loading earlier" size={24} />
          </div>
        ) : (
          <Button variant="ghost" className="room-load-earlier" onClick={() => void loadEarlier()}>
            Load earlier
          </Button>
        ))}
      <div
        className="room-timeline"
        ref={scroller}
        onScroll={onScroll}
        data-testid="room-timeline"
      >
          {loading && (
            <div className="room-loading">
              <LoadingMark label="Loading room" />
            </div>
          )}
          {!loading && !hasEarlier && (
            <div className="room-beginning">
              <div className="room-beginning-badge">
                <Logo size={26} />
              </div>
              <h2 className="room-beginning-title">{specTitle ?? specId}</h2>
              <p className="room-beginning-sub">
                This is the beginning of the{" "}
                <strong>{specTitle ?? specId}</strong> room.
                {groups.length === 0 &&
                  " Messages you post and the spec's lifecycle activity land here as the work moves."}
              </p>
              <p className="room-beginning-id">{specId}</p>
            </div>
          )}
          {groups.map((item, index) => {
            const previous = groups[index - 1];
            const daybreak = !previous || dayOf(previous.occurredAt) !== dayOf(item.occurredAt);
            const separator = daybreak && (
              <div className="room-day" key={`day:${item.id}`} role="separator">
                <span>{dayLabel(item.occurredAt)}</span>
              </div>
            );
            if (item.kind === "message-group") {
              const run = sources.current.runs.find(
                (candidate) => candidate.principal === item.author,
              );
              const isAgent = !!run || item.author.includes("/");
              return (
                <Fragment key={item.id}>
                  {separator}
                  <article
                    className="room-message-group"
                    data-testid={`message-group-${item.id}`}
                  >
                    <Avatar author={item.author} agent={isAgent} />
                    <div className="room-message-content">
                      <header className="room-message-head">
                        <strong>{authorLabel(item.author, sources.current.runs)}</strong>
                        <time dateTime={item.occurredAt}>{dateTime(item.occurredAt)}</time>
                      </header>
                      <div className="room-message-bodies">
                        {item.messages.map((entry) => (
                          <div
                            key={entry.id}
                            className={`room-message-body${entry.message.delivery ? ` is-${entry.message.delivery}` : ""}${entry.message.question ? " is-question" : ""}${live.cutShort.has(entry.message.id) ? " is-cut-short" : ""}`}
                            data-testid={`room-message-${entry.message.id}`}
                          >
                            {entry.message.question && (
                              <span
                                className="room-message-question"
                                data-testid={`question-${entry.message.id}`}
                              >
                                Question
                              </span>
                            )}
                            <Markdown source={entry.message.body} />
                            {live.cutShort.has(entry.message.id) && (
                              <TurnCutShort reason={live.cutShort.get(entry.message.id) ?? ""} />
                            )}
                            {entry.message.delivery === "pending" && (
                              <span className="room-message-delivery">
                                <Spinner size={12} />
                                Sending…
                              </span>
                            )}
                            {entry.message.delivery === "failed" && (
                              <div className="room-message-error">
                                <span>{entry.message.error}</span>
                                <Button
                                  variant="ghost"
                                  onClick={() => void submitMessage(entry.message)}
                                >
                                  Retry
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </article>
                </Fragment>
              );
            }
            if (item.kind === "lifecycle") {
              const detail = eventDetail(item.event);
              return (
                <Fragment key={item.id}>
                  {separator}
                  <div className="room-system-row">
                    <span className="room-system-mark" aria-hidden="true" />
                    <span>{item.label.toLowerCase()}</span>
                    <span>·</span>
                    <span>{eventActor(item.event, item.run).split("/")[0]}</span>
                    {detail && <span>· {detail}</span>}
                    <span>·</span>
                    <time dateTime={item.occurredAt}>{dateTime(item.occurredAt)}</time>
                    {item.event.type.startsWith("snapshot_") && (
                      <button
                        type="button"
                        className="dep-chip"
                        onClick={() => setSnapshotsProject(item.event.project)}
                      >
                        snapshots
                      </button>
                    )}
                  </div>
                </Fragment>
              );
            }
            if (item.kind === "decision") {
              return (
                <Fragment key={item.id}>
                  {separator}
                  <div className="room-system-row room-decision-row">
                    <span className="room-system-mark" aria-hidden="true" />
                    <span>
                      {item.decision.actor} {item.decision.action}
                      {item.decision.findingId
                        ? ` finding ${item.decision.findingId}`
                        : ` review ${item.decision.reviewId}`}
                    </span>
                    <span>·</span>
                    <time dateTime={item.occurredAt}>{dateTime(item.occurredAt)}</time>
                  </div>
                </Fragment>
              );
            }
            const expanded = expandedReviews.has(item.review.id);
            const openCount = item.findings.filter(
              (finding) => finding.resolution === "OPEN",
            ).length;
            return (
              <Fragment key={item.id}>
                {separator}
                <article className="room-review-card">
                  <button
                    type="button"
                    className="room-review-head"
                    data-testid={`review-row-${item.review.id}`}
                    onClick={() =>
                      setExpandedReviews((current) => {
                        const next = new Set(current);
                        if (next.has(item.review.id)) next.delete(item.review.id);
                        else next.add(item.review.id);
                        return next;
                      })
                    }
                  >
                    <span>
                      Review #{item.review.iteration} · {item.review.status.replaceAll("_", " ")} ·{" "}
                      {item.findings.length} findings · {openCount} open
                    </span>
                  </button>
                  {expanded && (
                    <div className="room-review-body">
                      {item.findings.length === 0 && (
                        <p className="meta-value">No findings. A clean review.</p>
                      )}
                      {item.findings.map((finding) => (
                        <FindingRow key={finding.id} finding={finding} />
                      ))}
                    </div>
                  )}
                </article>
              </Fragment>
            );
          })}
          {live.drafts
            .filter((entry) => !entry.behind)
            .map((entry) => (
              <DraftRow
                key={`${entry.runId}:${entry.turn}`}
                draft={entry}
                label={authorLabel(entry.principal, sources.current.runs)}
              />
            ))}
          {!live.drafts.some((entry) => !entry.behind || hasWritten(entry)) && (
            <TypingRow
              specId={specId}
              engagement={engagement}
              lastAgentReplyAt={lastAgentReplyAt}
            />
          )}
      </div>
      {behindPill > 0 && (
        <button type="button" className="room-new-pill" onClick={jumpToLatest}>
          {behindPill} new
        </button>
      )}
      {canWrite ? (
        <div className="room-composer">
          <Textarea
            value={draft}
            maxLength={65_536}
            autoGrow
            rows={1}
            placeholder="Message this room…"
            aria-label="Message this room"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="room-composer-row">
            <span className="room-composer-hint">shift + enter for new line</span>
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
      ) : (
        <p className="room-readonly">
          {["done", "cancelled", "archived"].includes(specStatus ?? "")
            ? `This room is ${specStatus} and read-only.`
            : "You don’t have write access."}
        </p>
      )}
      {snapshotsProject && (
        <SnapshotsPanel
          gateway={gateway}
          project={snapshotsProject}
          onClose={() => setSnapshotsProject(null)}
        />
      )}
    </div>
  );
}

/**
 * The iMessage-style typing indicator: the engaged agent's avatar and pulsing
 * dots as the last row of the conversation while its chat turn runs. "Typing"
 * means composing something you haven't seen yet, so the dots disappear the
 * moment the agent's reply lands for this turn and stay gone through the
 * turn's tail (the stop-gate checks and teardown that would otherwise read as
 * "more is coming"). Derived from the presence store's chat-lane entry plus
 * the newest agent message; the stop event clears the rest.
 */
export function typingVisible(
  presence: { startedAt?: number | null } | null,
  lastAgentReplyAt: number | null,
): boolean {
  if (!presence) return false;
  if (lastAgentReplyAt === null) return true;
  const startedAt = presence.startedAt ?? null;
  if (startedAt === null) return true;
  return lastAgentReplyAt < startedAt;
}

function TypingRow({
  specId,
  engagement,
  lastAgentReplyAt,
  store = presenceStore,
}: {
  specId: string;
  engagement?: EngagementView;
  /** Epoch ms of the engaged agent's newest room message, or null. */
  lastAgentReplyAt: number | null;
  store?: PresenceStore;
}) {
  const version = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.version,
  );
  const thinking = useMemo(
    () => typingVisible(store.chatPresenceOf(specId, Date.now()), lastAgentReplyAt),
    [store, specId, version, lastAgentReplyAt],
  );
  if (!engagement || !thinking) return null;
  return (
    <article className="room-message-group room-typing" data-testid={`typing-${specId}`}>
      <Avatar author={engagement.agent + "/"} agent />
      <div className="room-message-content">
        <header className="room-message-head">
          <strong>{engagement.agent}</strong>
        </header>
        <TypingDots name={engagement.agent} />
      </div>
    </article>
  );
}
