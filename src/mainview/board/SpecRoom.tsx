import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import type {
  Finding,
  ReviewDetailResponse,
  ReviewView,
  RunView,
  SailEvent,
} from "../../shared/sail-models";
import { Avatar } from "../components/Avatar";
import { Logo, Send } from "../components/icons";
import { LoadingMark } from "../components/Loading";
import { Textarea } from "../components/Textarea";
import { Tooltip } from "../components/Tooltip";
import { useToast } from "../components/Toast";
import { Badge, Button, type BadgeTone } from "../components/ui";
import type { Gateway } from "../gateway";
import { Markdown } from "../markdown";
import {
  assembleTimeline,
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

function FindingRow({
  finding,
  dismissing,
  canWrite,
  onDismiss,
}: {
  finding: Finding;
  dismissing: boolean;
  canWrite: boolean;
  onDismiss: () => void;
}) {
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
      {finding.resolution === "OPEN" && (
        <div className="finding-actions">
          <Button variant="ghost" disabled={!canWrite || dismissing} onClick={onDismiss}>
            {dismissing ? "Dismissing…" : "Dismiss"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SpecRoom({
  gateway,
  specId,
  specStatus,
  specTitle,
  canWrite,
  currentUser,
  onOpenLog,
}: {
  gateway: Gateway;
  specId: string;
  specStatus?: string;
  specTitle?: string;
  canWrite: boolean;
  currentUser?: string;
  onOpenLog: () => void;
}) {
  const [tail, setTail] = useState<BufferedTail<TimelineItem>>({
    visible: [],
    buffered: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [expandedReviews, setExpandedReviews] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const sources = useRef<Sources>(EMPTY_SOURCES);
  const atLatest = useRef(true);
  const posting = useRef(false);
  const deferredMessageEvents = useRef<Set<string>>(new Set());
  const loadVersion = useRef(0);
  const { showToast } = useToast();

  const applySources = useCallback((next: Sources, update: TimelineUpdate) => {
    sources.current = next;
    const timeline = assembleTimeline(next);
    setTail((previous) => reconcileTimeline(previous, timeline, update, atLatest.current));
  }, []);

  const loadReviewDetails = useCallback(
    async (reviews: ReviewView[]): Promise<ReviewDetailResponse[]> => {
      const details = await Promise.all(reviews.map((review) => gateway.reviewDetail(review.id)));
      return details.flatMap((result) => (result.ok ? [result.value] : []));
    },
    [gateway],
  );

  const loadRoom = useCallback(async (version: number) => {
    const [messages, recent, runs] = await Promise.all([
      gateway.listSpecMessages(specId, undefined, PAGE_SIZE),
      gateway.recentEvents(PAGE_SIZE),
      gateway.listRuns(specId),
    ]);
    if (version !== loadVersion.current) return;
    const base: Sources = {
      messages: messages.ok
        ? mergeMessages(messages.value.messages, sources.current.messages)
        : sources.current.messages,
      events: recent.ok
        ? mergeEvents(
            recent.value.events.filter((event) => event.spec === specId),
            sources.current.events,
          )
        : sources.current.events,
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
  }, [applySources, gateway, loadReviewDetails, specId]);

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

  useEffect(() => {
    if (!atLatest.current) return;
    requestAnimationFrame(() => {
      const element = scroller.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [tail.visible.length]);

  const refreshMessages = useCallback(
    async (live: boolean) => {
      const result = await gateway.listSpecMessages(specId, undefined, PAGE_SIZE);
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
    const off = gateway.onEvent((event) => {
      if (event.spec !== specId) return;
      if (event.type === "spec_message_posted") {
        const messageId =
          typeof event.data?.message_id === "string" ? event.data.message_id : undefined;
        if (messageId && sources.current.messages.some((message) => message.id === messageId)) return;
        if (posting.current && messageId) {
          deferredMessageEvents.current.add(messageId);
          return;
        }
        void refreshMessages(true);
        return;
      }
      const decision =
        event.type === "review_approved"
          ? { action: "approved" as const, reviewId: event.data?.review_id }
          : event.type === "finding_dismissed"
            ? {
                action: "dismissed" as const,
                reviewId: event.data?.review_id,
                findingId: event.data?.finding_id,
              }
            : undefined;
      applySources(
        {
          ...sources.current,
          events: mergeEvents(sources.current.events, [event]),
          decisions: decision
            ? sources.current.decisions.filter(
                (candidate) =>
                  candidate.action !== decision.action ||
                  candidate.reviewId !== decision.reviewId ||
                  candidate.findingId !== decision.findingId,
              )
            : sources.current.decisions,
        },
        "live",
      );
      void refreshReviewsAndRuns(true);
    });
    return off;
  }, [applySources, gateway, refreshMessages, refreshReviewsAndRuns, specId]);

  const jumpToLatest = useCallback(() => {
    atLatest.current = true;
    setTail((previous) => ({
      visible: [...previous.visible, ...previous.buffered].sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
      ),
      buffered: [],
    }));
    requestAnimationFrame(() => {
      const element = scroller.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, []);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    atLatest.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= SCROLL_EDGE_PX;
  };

  const loadEarlier = async () => {
    const oldest = sources.current.messages.find((message) => !message.delivery);
    if (!oldest) return;
    setLoadingEarlier(true);
    const result = await gateway.listSpecMessages(specId, oldest.id, PAGE_SIZE);
    setLoadingEarlier(false);
    if (!result.ok) return showToast("error", result.error.message);
    setHasEarlier(result.value.messages.length === PAGE_SIZE);
    atLatest.current = false;
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
    const result = await gateway.postSpecMessage(specId, { body: message.body });
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
    atLatest.current = true;
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

  const decide = async (reviewId: string, findingId?: string) => {
    const actionKey = findingId ?? reviewId;
    setActing((current) => new Set(current).add(actionKey));
    const result = findingId
      ? await gateway.dismissFinding(reviewId, findingId)
      : await gateway.approveReview(reviewId);
    setActing((current) => {
      const next = new Set(current);
      next.delete(actionKey);
      return next;
    });
    if (!result.ok) return showToast("error", result.error.message);
    const action = findingId ? "dismissed" : "approved";
    const decision: TimelineDecision = {
      id: `decision:${crypto.randomUUID()}`,
      reviewId,
      ...(findingId ? { findingId } : {}),
      action,
      actor: currentUser ?? "you",
      createdAt: new Date().toISOString(),
    };
    atLatest.current = true;
    applySources(
      {
        ...sources.current,
        reviews: sources.current.reviews.map((detail) =>
          detail.review.id !== reviewId
            ? detail
            : {
                ...detail,
                review: findingId
                  ? detail.review
                  : { ...detail.review, status: "approved", decided_by: decision.actor },
                findings: detail.findings.map((finding) =>
                  finding.id === findingId
                    ? { ...finding, resolution: "DISMISSED" as const }
                    : finding,
                ),
              },
        ),
        decisions: [...sources.current.decisions, decision],
      },
      "replace",
    );
  };

  const groups = groupTimeline(tail.visible);

  return (
    <div className="spec-room">
      {hasEarlier && (
        <Button
          variant="ghost"
          className="room-load-earlier"
          disabled={loadingEarlier}
          onClick={() => void loadEarlier()}
        >
          {loadingEarlier ? "Loading…" : "Load earlier"}
        </Button>
      )}
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
                <strong>{specTitle ?? specId}</strong> room. Messages you post and the
                spec's lifecycle activity land here as the work moves.
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
                            className={`room-message-body${entry.message.delivery ? ` is-${entry.message.delivery}` : ""}`}
                            data-testid={`room-message-${entry.message.id}`}
                          >
                            <Markdown source={entry.message.body} />
                            {entry.message.delivery === "pending" && (
                              <span className="room-message-delivery">Sending…</span>
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
                    <span>{item.run?.agent ?? item.event.agent.split("/")[0]}</span>
                    {detail && <span>· {detail}</span>}
                    <span>·</span>
                    <time dateTime={item.occurredAt}>{dateTime(item.occurredAt)}</time>
                    {item.run && (
                      <button type="button" className="dep-chip" onClick={onOpenLog}>
                        raw log
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
                        <p className="meta-value">No findings — a clean review.</p>
                      )}
                      {item.findings.map((finding) => (
                        <FindingRow
                          key={finding.id}
                          finding={finding}
                          dismissing={acting.has(finding.id)}
                          canWrite={canWrite}
                          onDismiss={() => void decide(item.review.id, finding.id)}
                        />
                      ))}
                      {item.review.status !== "approved" && (
                        <div className="room-review-actions">
                          <Button
                            variant={specStatus === "review" ? "primary" : "ghost"}
                            disabled={!canWrite || acting.has(item.review.id)}
                            onClick={() => void decide(item.review.id)}
                          >
                            {acting.has(item.review.id) ? "Approving…" : "Approve review"}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              </Fragment>
            );
          })}
      </div>
      {tail.buffered.length > 0 && (
        <button type="button" className="room-new-pill" onClick={jumpToLatest}>
          {tail.buffered.length} new
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
            <span className="room-composer-hint">⏎ to send</span>
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
            ? `This room is ${specStatus} — read-only.`
            : "You don’t have write access."}
        </p>
      )}
    </div>
  );
}
