import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  EngagementView,
  ReviewView,
  SailEvent,
  SpecMessage,
} from "../../shared/sail-models";
import { fakeRoomStreams } from "../../../test/roomStreams";
import { ToastProvider } from "../components/Toast";
import type { Gateway } from "../gateway";
import { presenceStore } from "./presenceStore";
import { SpecRoom } from "./SpecRoom";

let root: Root;
let container: HTMLElement;

const review: ReviewView = {
  id: "review-1",
  spec_id: "s1",
  iteration: 1,
  status: "pending_decision",
  created_at: "2026-07-28T10:00:00Z",
  completed_at: "2026-07-28T10:01:00Z",
  stages: [],
};

const lifecycleEvent = (id: number, type: string, spec = "s1"): SailEvent => ({
  v: 1,
  id,
  ts: `2026-07-28T09:00:0${id % 10}Z`,
  project: "mast",
  spec,
  type,
  agent: "sail",
  host: "devbox",
  data: {},
});

const remoteMessage = (id: string, body: string): SpecMessage => ({
  id,
  spec_id: "s1",
  author: "codex/run-1",
  body,
  created_at: "2026-07-28T10:02:00Z",
});

function makeGateway({
  withReview = false,
  reviewStatus = review.status,
  withFindings = true,
  postError,
  reviewGate,
  specEvents = [],
  specEventsError = false,
  globalEvents = [],
}: {
  withReview?: boolean;
  reviewStatus?: string;
  withFindings?: boolean;
  postError?: string;
  reviewGate?: Promise<void>;
  specEvents?: SailEvent[];
  specEventsError?: boolean;
  globalEvents?: SailEvent[];
} = {}) {
  let messages: SpecMessage[] = [];
  let history = specEvents;
  const listeners = new Set<(event: SailEvent) => void>();
  const statusListeners = new Set<(status: { stream: string }) => void>();
  const calls = {
    posts: [] as string[],
    specEvents: [] as { since?: number; limit?: number }[],
    eventLanes: [] as string[],
    messageOptions: [] as { before?: string; after?: string; limit?: number }[],
    recent: 0,
    messages: 0,
    reviews: 0,
    details: 0,
    runs: 0,
  };
  const selectedReview = { ...review, status: reviewStatus };
  const roomStreams = fakeRoomStreams();
  const gateway = {
    openRoomStream: roomStreams.openRoomStream,
    listSpecMessages: async (
      _id: string,
      options: { before?: string; after?: string; limit?: number } = {},
    ) => {
      calls.messages++;
      calls.messageOptions.push(options);
      let page: SpecMessage[];
      if (options.after) {
        page = messages.slice(messages.findIndex((message) => message.id === options.after) + 1);
        if (options.limit) page = page.slice(0, options.limit);
      } else if (options.before) {
        page = messages.slice(0, messages.findIndex((message) => message.id === options.before));
        if (options.limit) page = page.slice(-options.limit);
      } else {
        page = options.limit ? messages.slice(-options.limit) : messages;
      }
      return {
        ok: true as const,
        value: { spec_id: "s1", messages: page, total: page.length },
      };
    },
    postSpecMessage: async (_specId: string, request: { body: string }) => {
      calls.posts.push(request.body);
      if (postError) {
        return {
          ok: false as const,
          error: { status: 403, code: "forbidden", message: postError },
        };
      }
      const message: SpecMessage = {
        id: "message-1",
        spec_id: "s1",
        author: "uday",
        body: request.body,
        created_at: "2026-07-28T10:03:00Z",
      };
      messages = [...messages, message];
      listeners.forEach((listener) =>
        listener({
          v: 1,
          id: 10,
          ts: message.created_at,
          project: "mast",
          spec: "s1",
          type: "spec_message_posted",
          agent: "uday",
          host: "devbox",
          data: { message_id: message.id, preview: message.body },
        }),
      );
      return { ok: true as const, value: { message } };
    },
    recentEvents: async () => {
      calls.recent++;
      return {
        ok: true as const,
        value: { limit: 100, returned: globalEvents.length, events: globalEvents },
      };
    },
    specEvents: async (id: string, options: { since?: number; limit?: number } = {}) => {
      calls.specEvents.push(options);
      calls.eventLanes.push(id);
      if (specEventsError) {
        return {
          ok: false as const,
          error: { status: 405, code: "method_not_allowed", message: "old sail" },
        };
      }
      const scoped = history
        .filter((event) => event.spec === id)
        .filter((event) => options.since === undefined || (event.id ?? 0) > options.since)
        .slice(0, options.limit ?? 100);
      return {
        ok: true as const,
        value: { spec: "s1", limit: options.limit ?? 100, returned: scoped.length, events: scoped },
      };
    },
    specReviews: async () => {
      calls.reviews++;
      if (reviewGate) await reviewGate;
      return {
        ok: true as const,
        value: { spec_id: "s1", reviews: withReview ? [selectedReview] : [] },
      };
    },
    reviewDetail: async () => {
      calls.details++;
      return {
        ok: true as const,
        value: {
          review: selectedReview,
          findings: withFindings
            ? [
                {
                  id: "finding-1",
                  severity: "HIGH" as const,
                  category: "correctness",
                  file: "src/room.ts",
                  line_start: 12,
                  line_end: 12,
                  title: "Lost message",
                  description: "The echo can race the response.",
                  confidence: 0.9,
                  resolution: "OPEN" as const,
                },
              ]
            : [],
        },
      };
    },
    listRuns: async () => {
      calls.runs++;
      return {
        ok: true as const,
        value: {
          spec: "s1",
          runs: [
            {
              id: "run-1",
              project: "mast",
              spec_id: "s1",
              node: "devbox",
              role: "build" as const,
              agent: "codex",
              status: "running",
              started_at: "2026-07-28T10:00:00Z",
              principal: "codex/run-1",
              owner: "uday",
            },
          ],
        },
      };
    },
    onEvent: (listener: (event: SailEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnectionStatus: (listener: (status: { stream: string }) => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
  return {
    gateway: gateway as unknown as Gateway,
    calls,
    roomStreams,
    setHistory(events: SailEvent[]) {
      history = events;
    },
    setStream(stream: string) {
      statusListeners.forEach((listener) => listener({ stream }));
    },
    store(message: SpecMessage) {
      messages = [...messages, message];
    },
    receive(message: SpecMessage) {
      messages = [...messages, message];
      listeners.forEach((listener) =>
        listener({
          v: 1,
          id: 11,
          ts: message.created_at,
          project: "mast",
          spec: "s1",
          type: "spec_message_posted",
          agent: message.author,
          host: "devbox",
          data: {
            message_id: message.id,
            preview: message.body,
            ...(message.question ? { question: true } : {}),
          },
        }),
      );
    },
    emit(event: SailEvent) {
      listeners.forEach((listener) => listener(event));
    },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {});
}

async function mount(
  gateway: Gateway,
  specStatus?: string,
  specTitle?: string,
  roomId?: string,
  engagement?: EngagementView,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <SpecRoom
          gateway={gateway}
          specId="s1"
          roomId={roomId}
          specStatus={specStatus}
          specTitle={specTitle}
          canWrite
          currentUser="uday"
          engagement={engagement}
        />
      </ToastProvider>,
    ),
  );
  await settle();
}

function enterMessage(body: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message this room"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, body);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SpecRoom", () => {
  test("optimistically posts and reconciles the SSE echo without a duplicate", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    enterMessage("Room hello");
    await settle();

    expect(fake.calls.posts).toEqual(["Room hello"]);
    expect(container.querySelectorAll('[data-testid^="room-message-"]').length).toBe(1);
    expect(container.textContent).toContain("Room hello");
    expect(container.textContent).not.toContain("Sending…");
  });

  test("fetches a remote message from its SSE id instead of rendering the preview", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    act(() => fake.receive(remoteMessage("message-2", "Full body from the server")));
    await settle();

    expect(container.textContent).toContain("Full body from the server");
    expect(container.textContent).toContain("codex (for uday)");
  });

  test("a live snapshot_created event renders as a system row naming the label", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    act(() =>
      fake.emit({
        v: 1,
        id: 42,
        ts: "2026-08-16T10:00:00Z",
        project: "mast",
        spec: "s1",
        type: "snapshot_created",
        agent: "sail",
        host: "devbox",
        data: { label: "invite-run-7", run_id: "run-7" },
      }),
    );
    await settle();

    const rows = Array.from(container.querySelectorAll(".room-system-row"));
    const snapshot = rows.find((row) => /snapshot/i.test(row.textContent ?? ""));
    expect(snapshot).not.toBeUndefined();
    expect(snapshot?.textContent).toContain("invite-run-7");
  });

  test("a question message renders with the marker, answered prose stays plain", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    fake.receive({ ...remoteMessage("m-question", "Which auth flow?"), question: true });
    await settle();
    fake.receive(remoteMessage("m-plain", "Continuing with PKCE."));
    await settle();

    const question = container.querySelector('[data-testid="room-message-m-question"]')!;
    expect(question.classList.contains("is-question")).toBe(true);
    expect(question.querySelector('[data-testid="question-m-question"]')?.textContent).toBe(
      "Question",
    );
    const plain = container.querySelector('[data-testid="room-message-m-plain"]')!;
    expect(plain.classList.contains("is-question")).toBe(false);
    expect(plain.querySelector('[data-testid^="question-"]')).toBeNull();
  });

  test("renders consecutive agent reports as one visual group", async () => {
    const fake = makeGateway();
    for (let index = 0; index < 4; index++) {
      fake.receive({
        ...remoteMessage(`message-${index}`, `Report ${index + 1}`),
        created_at: `2026-07-28T10:0${index}:00Z`,
      });
    }
    await mount(fake.gateway);

    expect(container.querySelectorAll('[data-testid^="message-group-"]').length).toBe(1);
    expect(container.querySelectorAll('[data-testid^="room-message-"]').length).toBe(4);
    expect(container.querySelectorAll(".room-avatar.is-agent").length).toBe(1);
  });

  test("renders a 403 message verbatim with an inline retry", async () => {
    const refusal = "Spec 's1' is assigned to ravi, not you.";
    const fake = makeGateway({ postError: refusal });
    await mount(fake.gateway);

    enterMessage("Can I post?");
    await settle();

    expect(container.querySelector(".room-message-error span")?.textContent).toBe(refusal);
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
    ).toBe(true);
  });

  test("buffers live arrivals while scrolled up and releases them from the new pill", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    const timeline = container.querySelector<HTMLElement>('[data-testid="room-timeline"]')!;
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 900 },
    });
    act(() => timeline.dispatchEvent(new Event("scroll", { bubbles: true })));
    timeline.scrollTop = 0;
    act(() => timeline.dispatchEvent(new Event("scroll", { bubbles: true })));

    act(() => fake.receive(remoteMessage("message-3", "Held at the tail")));
    await settle();

    expect(container.textContent).not.toContain("Held at the tail");
    const pill = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "1 new",
    )!;
    act(() => pill.click());
    expect(container.textContent).toContain("Held at the tail");
  });

  test("the review card narrates: verdict and findings, no approve or dismiss controls", async () => {
    const fake = makeGateway({ withReview: true });
    await mount(fake.gateway, "review");

    expect(container.querySelectorAll(".room-review-card").length).toBe(1);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="review-row-review-1"]')!
        .click(),
    );
    const body = container.querySelector(".room-review-body")!;
    expect(body.textContent).toContain("Lost message");
    expect(body.querySelectorAll("button").length).toBe(0);
    expect(container.textContent).not.toContain("Approve review");
    expect(container.textContent).not.toContain("Dismiss");
  });

  test("a lifecycle row names its run but offers no raw-log door", async () => {
    const fake = makeGateway({ specEvents: [lifecycleEvent(1, "spec_dispatched")] });
    await mount(fake.gateway);

    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.querySelector("button") === null)).toBe(true);
    expect(container.textContent).not.toContain("raw log");
  });

  test("a lifecycle row names the publisher the server stamped, not the claimed agent", async () => {
    const forged: SailEvent = {
      ...lifecycleEvent(1, "spec_dispatched"),
      agent: "root",
      publisher: { handle: "ada", role: "member", lane: "api" },
    };
    const hook: SailEvent = {
      ...lifecycleEvent(2, "agent_stop_nudged"),
      agent: "root",
      publisher: { handle: "claude/run-9", role: "member", lane: "agent" },
    };
    const fake = makeGateway({ specEvents: [forged, hook, lifecycleEvent(3, "spec_restarted")] });
    await mount(fake.gateway);

    const rows = [...container.querySelectorAll(".room-system-row")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows.some((row) => row.includes("ada"))).toBe(true);
    expect(rows.some((row) => row.includes("claude") && !row.includes("claude/run-9"))).toBe(true);
    expect(rows.some((row) => row.includes("sail"))).toBe(true);
    expect(rows.some((row) => row.includes("root"))).toBe(false);
  });

  test("a lifecycle row of a known run names the publisher, and the run's agent only when unstamped", async () => {
    const stamped: SailEvent = {
      ...lifecycleEvent(1, "agent_session_stopped"),
      data: { run_id: "run-1" },
      publisher: { handle: "ada", role: "member", lane: "api" },
    };
    const unstamped: SailEvent = {
      ...lifecycleEvent(2, "spec_restarted"),
      data: { run_id: "run-1" },
    };
    const fake = makeGateway({ specEvents: [stamped, unstamped] });
    await mount(fake.gateway);

    const rows = [...container.querySelectorAll(".room-system-row")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows.some((row) => row.includes("ada") && !row.includes("codex"))).toBe(true);
    expect(rows.some((row) => row.includes("codex") && !row.includes("ada"))).toBe(true);
  });

  test("a killed run and a failed fix iteration each say why on their row", async () => {
    const killed: SailEvent = {
      ...lifecycleEvent(1, "agent_session_stopped"),
      data: { run_role: "room", source: "watcher", reason: "time limit (4h)" },
    };
    const fixFailed: SailEvent = {
      ...lifecycleEvent(2, "review_iteration_failed"),
      data: { detail: "fix agent killed: time limit (45m)" },
    };
    const fake = makeGateway({ specEvents: [killed, fixFailed] });
    await mount(fake.gateway);

    const rows = [...container.querySelectorAll(".room-system-row")].map(
      (row) => row.textContent ?? "",
    );
    const stop = rows.find((row) => row.includes("agent stopped"));
    expect(stop).toContain("time limit (4h)");
    expect(stop).not.toContain("exit");
    expect(rows.find((row) => row.includes("fix iteration failed"))).toContain(
      "fix agent killed: time limit (45m)",
    );
  });

  test("shows a failed review status even when the review has no findings", async () => {
    const failed = makeGateway({ withReview: true, reviewStatus: "failed", withFindings: false });
    await mount(failed.gateway);

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="review-row-review-1"]')?.textContent,
    ).toContain("Review #1 · failed · 0 findings · 0 open");
  });

  test("shows the loading mark, not text, while the room loads", async () => {
    const fake = makeGateway();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <ToastProvider>
          <SpecRoom
            gateway={fake.gateway}
            specId="s1"
            canWrite
            currentUser="uday"
          />
        </ToastProvider>,
      ),
    );
    expect(container.querySelector('[data-testid="loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Loading room…");
    await settle();
    expect(container.querySelector('[data-testid="loading"]')).toBeNull();
  });

  test("paints the conversation before reviews resolve, then fills them in", async () => {
    let releaseReviews!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReviews = resolve;
    });
    const fake = makeGateway({ withReview: true, reviewGate: gate });
    await mount(fake.gateway);

    expect(
      container.querySelector('[data-testid="loading"]'),
      "the conversation must paint without waiting on the per-review detail round-trips",
    ).toBeNull();
    expect(container.querySelector('[data-testid="review-row-review-1"]')).toBeNull();

    releaseReviews();
    await settle();

    expect(
      container.querySelector('[data-testid="review-row-review-1"]'),
      "reviews fill in behind the conversation once their round-trips complete",
    ).not.toBeNull();
  });

  test("an empty room shows the beginning block with the room title and id", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, "in_progress", "Bulk capture campaign");

    const beginning = container.querySelector(".room-beginning");
    expect(beginning, "an empty room shows a beginning block, not a bare sentence").not.toBeNull();
    expect(beginning?.querySelector(".room-beginning-title")?.textContent).toBe(
      "Bulk capture campaign",
    );
    expect(beginning?.textContent).toContain("the beginning of");
    expect(
      beginning?.textContent,
      "an empty room invites the first message with guidance text",
    ).toContain("land here as the work moves");
    expect(beginning?.querySelector(".room-beginning-id")?.textContent).toBe("s1");
  });

  test("the beginning marker persists at the top after the first message", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, "in_progress", "Bulk capture campaign");
    expect(container.querySelector(".room-beginning")).not.toBeNull();

    enterMessage("first message");
    await settle();

    const beginning = container.querySelector(".room-beginning");
    expect(
      beginning,
      "the beginning marker is the room's start; it must stay above the conversation, not vanish",
    ).not.toBeNull();
    expect(beginning?.textContent).toContain("the beginning of");
    expect(
      beginning?.textContent,
      "the empty-room guidance is dropped once the conversation has started",
    ).not.toContain("land here as the work moves");
    expect(container.textContent).toContain("first message");
  });

  test("separates the timeline by day with one separator per calendar day", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    act(() => fake.receive(remoteMessage("message-day-1", "first day")));
    await settle();
    act(() =>
      fake.receive({
        ...remoteMessage("message-day-2", "second day"),
        created_at: "2026-07-29T09:00:00Z",
      }),
    );
    await settle();

    const separators = [...container.querySelectorAll(".room-day")];
    expect(separators.length).toBe(2);
    expect(container.textContent).toContain("first day");
    expect(container.textContent).toContain("second day");
  });

  test("the composer is a contained surface with an icon send and a terse hint", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    const sendButton = container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    expect(sendButton).not.toBeNull();
    expect(sendButton.textContent).toBe("");
    expect(sendButton.disabled).toBe(true);
    expect(container.querySelector(".room-composer-hint")?.textContent).toBe(
      "shift + enter for new line",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message this room"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(textarea, "hello");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
    await settle();
    expect(fake.calls.posts).toEqual(["hello"]);
  });

  test("a done room replaces the composer with a read-only whisper", async () => {
    const fake = makeGateway();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <ToastProvider>
          <SpecRoom
            gateway={fake.gateway}
            specId="s1"
            specStatus="done"
            canWrite={false}
            currentUser="uday"
          />
        </ToastProvider>,
      ),
    );
    await settle();

    expect(container.querySelector('[aria-label="Message this room"]')).toBeNull();
    expect(container.querySelector('[aria-label="Send"]')).toBeNull();
    expect(container.querySelector(".room-readonly")?.textContent).toBe(
      "This room is done and read-only.",
    );
  });

  test("backfills from the spec-scoped history so lifecycle rows survive a busy global stream", async () => {
    const fake = makeGateway({ specEvents: [lifecycleEvent(1, "spec_dispatched")] });
    await mount(fake.gateway);

    expect(fake.calls.specEvents).toEqual([{ limit: 100 }]);
    expect(fake.calls.recent).toBe(0);
    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.some((row) => /dispatched/i.test(row.textContent ?? ""))).toBe(true);
  });

  test("falls back to the filtered global window when the server predates ?spec=", async () => {
    const fake = makeGateway({
      specEventsError: true,
      globalEvents: [
        lifecycleEvent(1, "spec_dispatched"),
        lifecycleEvent(2, "spec_dispatched", "other-spec"),
      ],
    });
    await mount(fake.gateway);

    expect(fake.calls.recent).toBe(1);
    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.filter((row) => /dispatched/i.test(row.textContent ?? "")).length).toBe(1);
  });

  test("gap-fills scoped from the last seen event id on reconnect, without duplicates", async () => {
    const fake = makeGateway({ specEvents: [lifecycleEvent(5, "spec_dispatched")] });
    await mount(fake.gateway);

    fake.setHistory([lifecycleEvent(5, "spec_dispatched"), lifecycleEvent(6, "agent_session_stopped")]);
    act(() => fake.setStream("connected"));
    act(() => fake.setStream("reconnecting"));
    act(() => fake.setStream("connected"));
    await settle();

    expect(fake.calls.specEvents).toEqual([{ limit: 100 }, { since: 5, limit: 100 }]);
    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.filter((row) => /dispatched/i.test(row.textContent ?? "")).length).toBe(1);
    expect(rows.some((row) => /agent stopped/i.test(row.textContent ?? ""))).toBe(true);
  });

  test("gap-fill drains the home room's event lane for a spec born in another room", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, "den");

    fake.setHistory([lifecycleEvent(7, "pty_session_started", "den")]);
    act(() => fake.setStream("connected"));
    act(() => fake.setStream("reconnecting"));
    act(() => fake.setStream("connected"));
    await settle();

    const reconnectLanes = fake.calls.eventLanes.slice(2);
    expect(reconnectLanes).toEqual(["s1", "den"]);
    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.some((row) => /terminal opened/i.test(row.textContent ?? ""))).toBe(true);
  });

  test("the room lane's backlog is not hidden by the spec lane's newer event ids", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, "den");

    fake.setHistory([
      lifecycleEvent(10, "spec_dispatched"),
      lifecycleEvent(8, "pty_session_started", "den"),
    ]);
    act(() => fake.setStream("connected"));
    act(() => fake.setStream("reconnecting"));
    act(() => fake.setStream("connected"));
    await settle();

    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.some((row) => /dispatched/i.test(row.textContent ?? ""))).toBe(true);
    expect(
      rows.some((row) => /terminal opened/i.test(row.textContent ?? "")),
      "a room event with an id below the spec lane's maximum must still gap-fill",
    ).toBe(true);
  });

  test("a live message event scoped to the home room refreshes messages for a spec born elsewhere", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, "den");
    const before = fake.calls.messages;

    act(() =>
      fake.emit({
        v: 1,
        id: 12,
        ts: "2026-08-31T00:00:00Z",
        project: "mast",
        spec: "den",
        type: "spec_message_posted",
        agent: "ada",
        host: "devbox",
        data: { message_id: "m-room", preview: "hi" },
      }),
    );
    await settle();

    expect(fake.calls.messages - before).toBe(1);
  });

  test("gap-fill pages until the server is drained, not just the first 100", async () => {
    const seed = lifecycleEvent(5, "spec_dispatched");
    const fake = makeGateway({ specEvents: [seed] });
    await mount(fake.gateway);

    const many = Array.from({ length: 105 }, (_, i) =>
      lifecycleEvent(6 + i, "agent_session_stopped"),
    );
    fake.setHistory([seed, ...many]);
    act(() => fake.setStream("connected"));
    act(() => fake.setStream("reconnecting"));
    act(() => fake.setStream("connected"));
    await settle();

    expect(
      fake.calls.specEvents.slice(1),
      "gap-fill must keep paging past the first 100 events until the server returns a short page",
    ).toEqual([
      { since: 5, limit: 100 },
      { since: 105, limit: 100 },
    ]);
  });

  test("gap-fill refreshes the message list and review/run state, not just the timeline", async () => {
    const seed = lifecycleEvent(5, "spec_dispatched");
    const fake = makeGateway({ specEvents: [seed] });
    await mount(fake.gateway);
    const before = { ...fake.calls };

    fake.setHistory([
      seed,
      lifecycleEvent(6, "spec_message_posted"),
      lifecycleEvent(7, "agent_session_stopped"),
    ]);
    act(() => fake.setStream("connected"));
    act(() => fake.setStream("reconnecting"));
    act(() => fake.setStream("connected"));
    await settle();

    expect(
      fake.calls.messages,
      "a gap-filled message event must refresh the durable message list",
    ).toBeGreaterThan(before.messages);
    expect(
      fake.calls.reviews,
      "a gap-filled lifecycle event must refresh reviews",
    ).toBeGreaterThan(before.reviews);
    expect(fake.calls.runs, "a gap-filled lifecycle event must refresh runs").toBeGreaterThan(
      before.runs,
    );
  });

  test("a remote message event costs one messages call carrying after, nothing else", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-seed", "Already here"));
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() => fake.receive(remoteMessage("message-new", "Fresh arrival")));
    await settle();

    expect(fake.calls.messages - before.messages).toBe(1);
    expect(fake.calls.messageOptions.at(-1)).toEqual({ after: "message-seed", limit: 100 });
    expect(fake.calls.reviews).toBe(before.reviews);
    expect(fake.calls.details).toBe(before.details);
    expect(fake.calls.runs).toBe(before.runs);
    expect(container.textContent).toContain("Fresh arrival");
  });

  test("recovers an out-of-order message by anchoring the fallback, not refetching the latest page", async () => {
    const fake = makeGateway();
    for (let i = 0; i <= 100; i++) {
      fake.receive(remoteMessage(`msg-${String(i).padStart(3, "0")}`, `Body ${i}`));
    }
    await mount(fake.gateway);
    const seen = fake.calls.messageOptions.length;

    // msg-000 fell below the newest page at load; its id is older than the after-cursor, so the
    // forward fetch skips it. The recovery must reach back to its position, not the latest page.
    act(() =>
      fake.emit({
        v: 1,
        id: 200,
        ts: "2026-07-28T10:02:00Z",
        project: "mast",
        spec: "s1",
        type: "spec_message_posted",
        agent: "codex/run-1",
        host: "devbox",
        data: { message_id: "msg-000", preview: "Body 0" },
      }),
    );
    await settle();

    expect(
      fake.calls.messageOptions.slice(seen).at(-1),
      "the recovery anchors before the missing message's successor, not the latest page",
    ).toEqual({ before: "msg-001", limit: 100 });
  });

  test("a review stage event with a review id refreshes that detail only", async () => {
    const fake = makeGateway({ withReview: true });
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() =>
      fake.emit({
        ...lifecycleEvent(21, "review_stage_passed"),
        data: { review_id: "review-1", detail: "correctness" },
      }),
    );
    await settle();

    expect(fake.calls.details - before.details).toBe(1);
    expect(fake.calls.reviews).toBe(before.reviews);
    expect(fake.calls.runs).toBe(before.runs);
    expect(fake.calls.messages).toBe(before.messages);
  });

  test("a review event without a review id falls back to the review list", async () => {
    const fake = makeGateway({ withReview: true });
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() => fake.emit(lifecycleEvent(22, "review_stage_passed")));
    await settle();

    expect(fake.calls.reviews - before.reviews).toBe(1);
    expect(fake.calls.runs).toBe(before.runs);
    expect(fake.calls.messages).toBe(before.messages);
  });

  test("a run-lifecycle event refreshes runs only", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() => fake.emit(lifecycleEvent(23, "agent_session_stopped")));
    await settle();

    expect(fake.calls.runs - before.runs).toBe(1);
    expect(fake.calls.reviews).toBe(before.reviews);
    expect(fake.calls.details).toBe(before.details);
    expect(fake.calls.messages).toBe(before.messages);
  });

  test("a live run's telemetry and presence stream costs zero fetches and zero rows", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    const before = { ...fake.calls };
    const rowsBefore = container.querySelectorAll(".room-system-row").length;

    act(() => {
      for (let index = 0; index < 20; index++) {
        const type = index % 2 === 0 ? "agent_tool_started" : "agent_tool_finished";
        fake.emit({ ...lifecycleEvent(30 + index, type), data: { tool: "Bash" } });
      }
      fake.emit({ ...lifecycleEvent(50, "agent_presence"), data: { presence: "working" } });
      fake.emit({ ...lifecycleEvent(51, "agent_presence"), data: { presence: "quiet" } });
    });
    await settle();

    expect(fake.calls).toEqual(before);
    expect(container.querySelectorAll(".room-system-row").length).toBe(rowsBefore);
  });

  test("a burst of mixed events coalesces into one fetch per kind", async () => {
    const fake = makeGateway({ withReview: true });
    fake.receive(remoteMessage("message-seed", "Already here"));
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() => {
      fake.emit(lifecycleEvent(61, "agent_session_stopped"));
      fake.emit(lifecycleEvent(62, "agent_failed"));
      fake.emit({
        ...lifecycleEvent(63, "review_stage_passed"),
        data: { review_id: "review-1" },
      });
      fake.emit({
        ...lifecycleEvent(64, "review_stage_failed"),
        data: { review_id: "review-1" },
      });
      fake.receive(remoteMessage("message-burst", "Mid-burst message"));
    });
    await settle();

    expect(fake.calls.runs - before.runs).toBe(1);
    expect(fake.calls.details - before.details).toBe(1);
    expect(fake.calls.messages - before.messages).toBe(1);
    expect(fake.calls.reviews).toBe(before.reviews);
  });

  test("a status change renders its row without any fetch; unknown events stay conservative", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() =>
      fake.emit({
        ...lifecycleEvent(71, "spec_status_changed"),
        data: { from: "in_progress", to: "review" },
      }),
    );
    await settle();

    expect(fake.calls).toEqual(before);
    expect(container.textContent).toContain("status changed to review");

    act(() => fake.emit(lifecycleEvent(72, "spec_reticulated")));
    await settle();

    expect(
      fake.calls.reviews - before.reviews,
      "an unrecognized spec event must keep the conservative refresh",
    ).toBe(1);
    expect(fake.calls.runs - before.runs).toBe(1);
  });
});

describe("SpecRoom live turns", () => {
  const PRINCIPAL = "claude-code/run-7";
  const DRAFT = '[data-testid="draft-run-7-7"]';
  const TYPING = '[data-testid="typing-s1"]';

  const live = (type: string, data: Record<string, unknown> = {}, room = "s1"): SailEvent => ({
    v: 1,
    ts: "2026-07-28T10:02:00Z",
    project: "mast",
    spec: room,
    type,
    agent: "claude-code",
    host: "devbox",
    data: { run_id: "run-7", room_id: room, principal: PRINCIPAL, turn: 7, ...data },
  });
  const delta = (text: string) => live("agent_text_delta", { text });
  const turnEnded = (data: Record<string, unknown> = {}) =>
    live("agent_turn_ended", { is_error: false, ...data });
  const reply = (body: string, created_at = "2026-07-28T10:02:30Z"): SpecMessage => ({
    id: "message-7",
    spec_id: "s1",
    author: PRINCIPAL,
    body,
    created_at,
  });
  const announced = (id: number, message: SpecMessage): SailEvent => ({
    ...lifecycleEvent(id, "spec_message_posted"),
    agent: message.author,
    data: { message_id: message.id, preview: message.body },
  });
  const engaged = (agent: string): EngagementView => ({
    agent,
    mode: "full",
    engaged_at: "2026-07-28T09:00:00Z",
  });

  type Fake = ReturnType<typeof makeGateway>;
  const stream = (fake: Fake, ...events: SailEvent[]) =>
    act(() => events.forEach((event) => fake.roomStreams.emit(event.spec!, event)));
  const draft = () => container.querySelector<HTMLElement>(DRAFT);
  const occurrences = (text: string) => container.textContent!.split(text).length - 1;
  const pill = () => container.querySelector<HTMLButtonElement>(".room-new-pill");

  function scrollTo(scrollTop: number, scrollHeight = 1000) {
    const timeline = container.querySelector<HTMLElement>('[data-testid="room-timeline"]')!;
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: scrollHeight },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: scrollTop },
    });
    act(() => timeline.dispatchEvent(new Event("scroll", { bubbles: true })));
  }

  /** The member's chat run as the presence store sees it once its turn starts. */
  function chatTurnStarted() {
    act(() =>
      presenceStore.noteEvent({
        ...live("agent_session_started", { run_role: "room-full" }),
        ts: new Date().toISOString(),
      }),
    );
  }

  afterEach(() => act(() => presenceStore.noteRuns([])));

  test("opening a room opens its one stream, and leaving closes it", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    expect(fake.roomStreams.opened).toEqual(["s1"]);
    expect(fake.roomStreams.open()).toEqual(["s1"]);

    act(() => root.unmount());
    expect(fake.roomStreams.opened).toEqual(["s1"]);
    expect(fake.roomStreams.open()).toEqual([]);
  });

  test("a room swapped in place closes the old stream and keeps none of its drafts", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, "room-a");
    stream(fake, live("agent_text_delta", { text: "Room A's turn." }, "room-a"));
    expect(draft()).not.toBeNull();

    act(() =>
      root.render(
        <ToastProvider>
          <SpecRoom gateway={fake.gateway} specId="s1" roomId="room-b" canWrite />
        </ToastProvider>,
      ),
    );
    await settle();

    expect(fake.roomStreams.open()).toEqual(["room-b"]);
    expect(draft()).toBeNull();
  });

  test("a spec whose conversation lives in another room streams that room", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, "room-9");
    expect(fake.roomStreams.opened).toEqual(["room-9"]);

    stream(fake, live("agent_text_delta", { text: "In the home room." }, "room-9"));
    expect(draft()?.textContent).toContain("In the home room.");

    act(() => fake.roomStreams.emit("room-9", delta("Another room's turn.")));
    expect(container.textContent).not.toContain("Another room's turn.");
  });

  test("the deltas of a turn grow one draft bubble under the member's name and avatar", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    stream(fake, delta("Hello"));
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Hello");

    stream(fake, delta(", "), delta("room."));
    expect(container.querySelectorAll('[data-testid^="draft-"]').length).toBe(1);
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Hello, room.");
    expect(draft()?.querySelector(".room-message-head strong")?.textContent).toBe("claude-code");
    expect(draft()?.querySelector(".room-avatar.is-agent")?.getAttribute("aria-label")).toBe(
      `${PRINCIPAL}, agent`,
    );
  });

  test("the draft is named by the event's principal, not by the room's engagement", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("codex"));

    stream(fake, live("agent_text_delta", { text: "Hi", principal: "claude/room-run-7" }));

    expect(draft()?.querySelector(".room-message-head strong")?.textContent).toBe("claude");
    expect(draft()?.querySelector(".room-avatar")?.getAttribute("aria-label")).toBe(
      "claude/room-run-7, agent",
    );
  });

  test("a draft is the box's text drawn as text, never as markup", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    stream(
      fake,
      delta('**bold** <img src=x onerror="alert(1)">'),
      live("agent_tool_call", { tool: "<b>Bash</b>", summary: "<i>ls</i>", status: "started" }),
    );

    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      '**bold** <img src=x onerror="alert(1)">',
    );
    expect(draft()?.querySelector(".room-draft-tools")?.textContent).toContain("<b>Bash</b><i>ls</i>");
    expect(draft()?.querySelectorAll("img, b, i, .markdown").length).toBe(0);
  });

  test("a tool call is one line under the draft, running and then done", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    stream(
      fake,
      delta("Looking."),
      live("agent_tool_call", { tool: "Read", summary: "README.md", status: "started" }),
    );
    const lines = () => [...draft()!.querySelectorAll(".room-draft-tools li")];
    expect(lines().map((line) => line.textContent)).toEqual(["ReadREADME.mdrunning"]);
    expect(lines()[0]!.classList.contains("is-running")).toBe(true);

    stream(fake, live("agent_tool_call", { tool: "Read", status: "finished" }));
    expect(lines().map((line) => line.textContent)).toEqual(["ReadREADME.mddone"]);
    expect(lines()[0]!.classList.contains("is-running")).toBe(false);
  });

  test("the loop's own tool events draw nothing in the room, on either stream", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    const loop = { ...lifecycleEvent(60, "agent_tool_started"), data: { run_id: "run-1" } };

    stream(fake, loop);
    act(() => fake.emit(loop));
    await settle();

    expect(container.querySelector('[data-testid^="draft-"]')).toBeNull();
    expect(container.querySelector(".room-system-row")).toBeNull();
  });

  test("a turn that ends on a message already in the room is replaced by it in place", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("The **full** reply."));

    act(() => fake.receive(reply("The **full** reply.")));
    await settle();
    expect(draft()).not.toBeNull();

    stream(fake, turnEnded({ message_id: "message-7" }));

    expect(draft()).toBeNull();
    const message = container.querySelector('[data-testid="room-message-message-7"]')!;
    expect(message.querySelector(".markdown strong")?.textContent).toBe("full");
    expect(occurrences("reply.")).toBe(1);
  });

  test("a turn that ends before its message holds the draft, and the message replaces it: never empty, never twice", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("The full reply."), turnEnded({ message_id: "message-7" }));

    expect(draft()?.textContent).toContain("The full reply.");
    expect(container.querySelector('[data-testid="room-message-message-7"]')).toBeNull();

    const seen: number[] = [];
    const observer = new MutationObserver(() => seen.push(occurrences("The full reply.")));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    act(() => fake.receive(reply("The full reply.")));
    await settle();
    observer.disconnect();

    expect(draft()).toBeNull();
    expect(container.querySelector('[data-testid="room-message-message-7"]')).not.toBeNull();
    expect(occurrences("The full reply.")).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === 1)).toBe(true);
  });

  test("the typing row shows from the human's send until the first delta, then yields to the draft", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    enterMessage("Where do we start?");
    await settle();
    chatTurnStarted();
    expect(container.querySelector(TYPING)).not.toBeNull();

    stream(fake, delta("Here"));
    expect(container.querySelector(TYPING)).toBeNull();
    expect(draft()).not.toBeNull();
  });

  test("a stream that drops mid-turn keeps the draft with a marker, and the final message still replaces it", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Half a sent"));

    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    act(() => fake.roomStreams.setState("s1", "connected"));
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Half a sent … ");

    stream(fake, delta("and the rest."));
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      "Half a sent … and the rest.",
    );

    stream(fake, turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("Half a sentence, whole, and the rest.")));
    await settle();

    expect(draft()).toBeNull();
    expect(container.textContent).toContain("Half a sentence, whole, and the rest.");
    expect(container.textContent).not.toContain("…");
  });

  test("a drop that swallows the turn's end leaves the posted message to replace the draft", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    act(() => fake.receive(reply("Half a sentence, whole.")));
    await settle();

    expect(draft()).toBeNull();
    expect(container.textContent).toContain("Half a sentence, whole.");
    expect(occurrences("Half a sent")).toBe(1);
  });

  test("a disconnect that swallows the turn's end and its message's event leaves the recovered event to retire the draft", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    act(() => fake.setStream("connected"));
    stream(fake, delta("Half a sent"));

    act(() => {
      fake.roomStreams.setState("s1", "reconnecting");
      fake.setStream("reconnecting");
    });
    const whole = reply("Half a sentence, whole.");
    fake.store(whole);
    fake.setHistory([announced(12, whole)]);
    act(() => fake.setStream("connected"));
    await settle();

    expect(draft()).toBeNull();
    expect(container.textContent).toContain("Half a sentence, whole.");
    expect(occurrences("Half a sent")).toBe(1);
  });

  test("a recovered event for a reply the room already held leaves the draft of the turn still being written", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    act(() => fake.setStream("connected"));
    const before = { ...reply("The turn before.", "2026-07-28T10:01:00Z"), id: "message-6" };
    act(() => fake.receive(before));
    await settle();
    stream(fake, delta("Half a sent"));

    act(() => {
      fake.roomStreams.setState("s1", "reconnecting");
      fake.setStream("reconnecting");
    });
    fake.setHistory([announced(11, before)]);
    act(() => fake.setStream("connected"));
    await settle();

    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Half a sent … ");
    expect(occurrences("The turn before.")).toBe(1);
  });

  test("a replayed live event for a reply the room already held leaves the draft of the turn still being written", async () => {
    const fake = makeGateway();
    const before = { ...reply("The turn before.", "2026-07-28T10:01:00Z"), id: "message-6" };
    fake.store(before);
    await mount(fake.gateway);
    expect(container.querySelector('[data-testid="room-message-message-6"]')).not.toBeNull();
    stream(fake, delta("Current turn partial"));

    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    act(() => fake.emit(announced(11, before)));
    await settle();

    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      "Current turn partial … ",
    );
    expect(occurrences("The turn before.")).toBe(1);
  });

  test("a reply fetched before its event arrives still takes the place of a draft whose end was lost", async () => {
    const fake = makeGateway();
    let releaseMessages!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    let gated = false;
    const gateway = {
      ...fake.gateway,
      listSpecMessages: async (...request: Parameters<Gateway["listSpecMessages"]>) => {
        if (gated) await gate;
        return fake.gateway.listSpecMessages(...request);
      },
    };
    await mount(gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    gated = true;
    act(() => fake.receive({ ...reply("Any news?"), id: "message-6", author: "priya" }));
    const whole = reply("Half a sentence, whole.");
    fake.store(whole);
    releaseMessages();
    await settle();
    act(() => fake.emit(announced(12, whole)));
    await settle();

    expect(container.querySelector('[data-testid="room-message-message-7"]')).not.toBeNull();
    expect(draft()).toBeNull();
    expect(occurrences("Half a sent")).toBe(1);
  });

  test("a reply the room's first load brings before its event still takes the place of a draft whose end was lost", async () => {
    const fake = makeGateway();
    let releaseMessages!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    const gateway = {
      ...fake.gateway,
      listSpecMessages: async (...request: Parameters<Gateway["listSpecMessages"]>) => {
        await gate;
        return fake.gateway.listSpecMessages(...request);
      },
    };
    await mount(gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    expect(draft()).not.toBeNull();

    const whole = reply("Half a sentence, whole.");
    fake.store(whole);
    releaseMessages();
    await settle();
    act(() => fake.emit(announced(12, whole)));
    await settle();

    expect(container.querySelector('[data-testid="room-message-message-7"]')).not.toBeNull();
    expect(draft()).toBeNull();
    expect(occurrences("Half a sent")).toBe(1);
  });

  test("a reply the room held before its turn's stream dropped takes the draft's place at the drop", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.receive(reply("Half a sentence, whole.")));
    await settle();
    expect(draft()).not.toBeNull();

    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    expect(draft()).toBeNull();
    expect(occurrences("Half a sent")).toBe(1);
  });

  test("two turns whose ends were both lost end with both replies and no draft, one fetch bringing both", async () => {
    const fake = makeGateway();
    let releaseMessages!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    let gated = false;
    const gateway = {
      ...fake.gateway,
      listSpecMessages: async (...request: Parameters<Gateway["listSpecMessages"]>) => {
        if (gated) await gate;
        return fake.gateway.listSpecMessages(...request);
      },
    };
    await mount(gateway);
    stream(fake, delta("Seventh, half"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    gated = true;
    act(() => fake.receive(reply("Seventh, whole.")));
    act(() => fake.roomStreams.setState("s1", "connected"));
    stream(fake, {
      ...live("agent_text_delta", { text: "Eighth, half", turn: 8 }),
      ts: "2026-07-28T10:03:00Z",
    });
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    act(() =>
      fake.receive({ ...reply("Eighth, whole.", "2026-07-28T10:03:30Z"), id: "message-8" }),
    );
    expect(
      [...container.querySelectorAll<HTMLElement>(".room-draft")].map((row) => row.dataset.testid),
    ).toEqual(["draft-run-7-8"]);
    releaseMessages();
    await settle();

    expect(container.querySelector('[data-testid="room-message-message-7"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="room-message-message-8"]')).not.toBeNull();
    expect(container.querySelectorAll(".room-draft")).toHaveLength(0);
  });

  test("a member that dies with its box mid-turn leaves a draft only until the next member's turn begins", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    act(() => fake.roomStreams.setState("s1", "connected"));
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Half a sent … ");

    stream(fake, {
      ...live("agent_text_delta", {
        text: "A new member.",
        run_id: "run-8",
        principal: "claude-code/run-8",
        turn: 1,
      }),
      ts: "2026-07-28T10:05:00Z",
    });

    expect(
      [...container.querySelectorAll<HTMLElement>(".room-draft")].map((row) => row.dataset.testid),
    ).toEqual(["draft-run-8-1"]);
  });

  test("a note the member posts after a drop its turn survived leaves the draft", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("I'll start on the build."));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    act(() => fake.roomStreams.setState("s1", "connected"));
    stream(fake, delta("Still going."));

    act(() => fake.receive({ ...reply("Progress: step 1 done.", "2026-07-28T10:02:10Z"), id: "note-1" }));
    await settle();

    expect(container.querySelector('[data-testid="room-message-note-1"]')).not.toBeNull();
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      "I'll start on the build. … Still going.",
    );
  });

  test("an earlier turn's reply paged in by a recovery fetch leaves the draft of the turn still being written", async () => {
    const fake = makeGateway();
    fake.store({ ...reply("The turn before.", "2026-07-28T09:30:00Z"), id: "msg-000" });
    const missed = { ...remoteMessage("msg-001", "An old aside"), author: "priya" };
    fake.store(missed);
    for (let i = 2; i <= 101; i++) {
      fake.store(remoteMessage(`msg-${String(i).padStart(3, "0")}`, `Body ${i}`));
    }
    await mount(fake.gateway);
    expect(container.querySelector('[data-testid="room-message-msg-000"]')).toBeNull();
    stream(fake, delta("Current turn partial"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    act(() => fake.emit(announced(12, missed)));
    await settle();

    expect(fake.calls.messageOptions.at(-1)).toEqual({ before: "msg-002", limit: 100 });
    expect(container.querySelector('[data-testid="room-message-msg-000"]')).not.toBeNull();
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      "Current turn partial … ",
    );
  });

  test("an earlier turn's reply paged in by loading earlier leaves the draft of the turn still being written", async () => {
    const fake = makeGateway();
    fake.store({ ...reply("The turn before.", "2026-07-28T09:30:00Z"), id: "msg-000" });
    for (let i = 1; i <= 100; i++) {
      fake.store(remoteMessage(`msg-${String(i).padStart(3, "0")}`, `Body ${i}`));
    }
    await mount(fake.gateway);
    stream(fake, delta("Current turn partial"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    act(() => container.querySelector<HTMLButtonElement>(".room-load-earlier")!.click());
    await settle();

    expect(fake.calls.messageOptions.at(-1)).toEqual({ before: "msg-001", limit: 100 });
    expect(container.querySelector('[data-testid="room-message-msg-000"]')).not.toBeNull();
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      "Current turn partial … ",
    );
  });

  test("an earlier turn's reply first loaded mid-turn, after the room's message load failed, leaves the draft", async () => {
    const fake = makeGateway();
    fake.store({ ...reply("The turn before.", "2026-07-28T09:30:00Z"), id: "message-5" });
    let failing = true;
    const gateway = {
      ...fake.gateway,
      listSpecMessages: async (...request: Parameters<Gateway["listSpecMessages"]>) =>
        failing
          ? { ok: false as const, error: { status: 503, code: "unavailable", message: "down" } }
          : fake.gateway.listSpecMessages(...request),
    };
    await mount(gateway);
    expect(container.querySelector('[data-testid="room-message-message-5"]')).toBeNull();
    stream(fake, delta("Current turn partial"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    failing = false;
    act(() => fake.receive({ ...reply("Any news?"), id: "message-6", author: "priya" }));
    await settle();

    expect(container.querySelector('[data-testid="room-message-message-5"]')).not.toBeNull();
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe(
      "Current turn partial … ",
    );
  });

  test("a question fetched before its event leaves the draft of the turn still being written", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Let me ask."));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    fake.store({ ...reply("Which branch?"), id: "question-1", question: true });
    act(() => fake.receive({ ...reply("Any news?"), id: "message-6", author: "priya" }));
    await settle();

    expect(container.querySelector('[data-testid="room-message-question-1"]')).not.toBeNull();
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Let me ask. … ");
  });

  test("a question asked mid-turn does not take the draft's place when the stream drops", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Let me ask."));
    act(() => fake.receive({ ...reply("Which branch?"), id: "question-1", question: true }));
    await settle();
    expect(container.querySelector('[data-testid="room-message-question-1"]')).not.toBeNull();

    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Let me ask. … ");

    stream(fake, delta("Meanwhile."), turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("Let me ask. Meanwhile.")));
    await settle();
    expect(draft()).toBeNull();
    expect(container.querySelector('[data-testid="room-message-message-7"]')).not.toBeNull();
  });

  test("a turn that ended early is told: a muted bubble and the box's reason, on the draft and on the message it becomes", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(
      fake,
      delta("Partial"),
      turnEnded({ is_error: true, reason: "max_duration reached", message_id: "message-7" }),
    );

    expect(draft()?.querySelector(".room-draft-text")?.classList.contains("is-cut-short")).toBe(true);
    expect(draft()?.querySelector(".room-turn-cut-short")?.textContent).toBe(
      "the agent's turn ended early · max_duration reached",
    );

    act(() => fake.receive(reply("Partial")));
    await settle();

    expect(draft()).toBeNull();
    const message = container.querySelector('[data-testid="room-message-message-7"]')!;
    expect(message.classList.contains("is-cut-short")).toBe(true);
    expect(message.querySelector(".room-turn-cut-short")?.textContent).toBe(
      "the agent's turn ended early · max_duration reached",
    );
    expect(occurrences("the agent's turn ended early")).toBe(1);
  });

  test("an error turn with no reason and no message is still told, by the sentence alone", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    stream(fake, turnEnded({ is_error: true }));

    expect(draft()?.querySelector(".room-turn-cut-short")?.textContent).toBe(
      "the agent's turn ended early",
    );
  });

  test("a Codex member streams nothing: the typing row and the re-fetch behave as before", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("codex"));
    chatTurnStarted();
    expect(container.querySelector(TYPING)).not.toBeNull();

    act(() =>
      fake.receive({
        ...remoteMessage("message-2", "Whole, at once."),
        created_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await settle();

    expect(container.textContent).toContain("Whole, at once.");
    expect(container.querySelector(TYPING)).toBeNull();
    expect(container.querySelector('[data-testid^="draft-"]')).toBeNull();
  });

  test("a live event on the app-wide stream refreshes nothing and draws nothing", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    const before = { ...fake.calls };

    act(() => {
      fake.emit(delta("Not from the room's stream"));
      fake.emit(live("agent_tool_call", { tool: "Read", summary: "x", status: "started" }));
      fake.emit(turnEnded({ message_id: "message-7" }));
    });
    await settle();

    expect(fake.calls).toEqual(before);
    expect(container.querySelector('[data-testid^="draft-"]')).toBeNull();
    expect(container.querySelector(".room-system-row")).toBeNull();
  });

  test("a turn that begins while the reader is scrolled up is not drawn: the pill counts it, and scrolling down shows its message", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    scrollTo(0);

    stream(fake, delta("The full reply."));
    expect(draft()).toBeNull();
    expect(pill()?.textContent).toBe("1 new");

    stream(fake, turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("The full reply.")));
    await settle();
    expect(container.textContent).not.toContain("The full reply.");
    expect(pill()?.textContent).toBe("1 new");

    scrollTo(900);
    expect(container.textContent).toContain("The full reply.");
    expect(pill()).toBeNull();
  });

  test("a reader who returns to the latest mid-turn finds the draft where the pill was, and it stays when they leave again", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    scrollTo(900);
    scrollTo(0);
    stream(fake, delta("Still writing"));
    expect(draft()).toBeNull();
    expect(pill()?.textContent).toBe("1 new");

    scrollTo(900);
    expect(draft()?.textContent).toContain("Still writing");
    expect(pill()).toBeNull();

    scrollTo(0, 1400);
    stream(fake, delta(", still."));
    expect(draft()?.textContent).toContain("Still writing, still.");
    expect(pill()).toBeNull();
  });

  test("a reader who scrolls up while a turn is written keeps its draft, and its message takes the draft's place where they are", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("The full reply."));
    scrollTo(400, 1400);

    const seen: number[] = [];
    const observer = new MutationObserver(() => seen.push(occurrences("The full reply.")));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    stream(fake, turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("The full reply.")));
    await settle();
    observer.disconnect();

    expect(draft()).toBeNull();
    expect(container.querySelector('[data-testid="room-message-message-7"]')).not.toBeNull();
    expect(pill()).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === 1)).toBe(true);

    act(() => fake.receive(remoteMessage("message-8", "Landed while away")));
    await settle();
    expect(container.textContent).not.toContain("Landed while away");
    expect(pill()?.textContent).toBe("1 new");
  });

  test("a message that waited behind the pill before its turn's end named it comes out to take the draft's place", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("The full reply."));
    scrollTo(400, 1400);

    act(() => fake.receive(reply("The full reply, posted.")));
    await settle();
    expect(draft()).not.toBeNull();
    expect(pill()?.textContent).toBe("1 new");

    stream(fake, turnEnded({ message_id: "message-7" }));

    expect(draft()).toBeNull();
    expect(container.textContent).toContain("The full reply, posted.");
    expect(pill()).toBeNull();
  });

  test("the bottom moving away under a reader is not the reader leaving; moving up is, until they are back", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);

    scrollTo(900, 1400);
    act(() => fake.receive(remoteMessage("message-2", "Landed as the bottom moved")));
    await settle();
    expect(container.textContent).toContain("Landed as the bottom moved");
    expect(pill()).toBeNull();

    scrollTo(800, 1400);
    act(() => fake.receive(remoteMessage("message-3", "Landed while away")));
    await settle();
    expect(container.textContent).not.toContain("Landed while away");
    expect(pill()?.textContent).toBe("1 new");
    act(() => pill()!.click());
    expect(container.textContent).toContain("Landed while away");

    scrollTo(800, 1400);
    scrollTo(1300, 1400);
    act(() => fake.receive(remoteMessage("message-4", "Landed once back")));
    await settle();
    expect(container.textContent).toContain("Landed once back");
    expect(pill()).toBeNull();
  });

  test("the pill and a send each bring the reader back to following; loading earlier takes them away", async () => {
    const fake = makeGateway();
    for (let i = 0; i <= 100; i++) {
      fake.store(remoteMessage(`msg-${String(i).padStart(3, "0")}`, `Body ${i}`));
    }
    await mount(fake.gateway);
    scrollTo(900);
    scrollTo(0);
    act(() => fake.receive(remoteMessage("msg-200", "Behind the pill")));
    await settle();
    act(() => pill()!.click());
    act(() => fake.receive(remoteMessage("msg-201", "After the pill")));
    await settle();
    expect(container.textContent).toContain("After the pill");
    expect(pill()).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>(".room-load-earlier")!.click());
    await settle();
    act(() => fake.receive(remoteMessage("msg-202", "After loading earlier")));
    await settle();
    expect(container.textContent).not.toContain("After loading earlier");
    expect(pill()?.textContent).toBe("1 new");

    enterMessage("I am back");
    await settle();
    expect(container.textContent).toContain("After loading earlier");
    act(() => fake.receive(remoteMessage("msg-203", "After the send")));
    await settle();
    expect(container.textContent).toContain("After the send");
    expect(pill()).toBeNull();
  });

  test("a reader who moves up at all has left, even within reach of the latest; what was below them shrinking has not moved them", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);

    scrollTo(700, 800);
    act(() => fake.receive(remoteMessage("message-2", "Landed after the room shrank")));
    await settle();
    expect(container.textContent).toContain("Landed after the room shrank");
    expect(pill()).toBeNull();

    scrollTo(680, 800);
    act(() => fake.receive(remoteMessage("message-3", "Landed a nudge away")));
    await settle();
    expect(container.textContent).not.toContain("Landed a nudge away");
    expect(pill()?.textContent).toBe("1 new");
  });

  test("a reader at the latest is kept there as the draft grows, and their move up is told from the room's own", async () => {
    const frames: FrameRequestCallback[] = [];
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (frame) => frames.push(frame);
    try {
      const fake = makeGateway();
      fake.receive(remoteMessage("message-old", "Already visible"));
      await mount(fake.gateway);
      scrollTo(900);
      const timeline = container.querySelector<HTMLElement>('[data-testid="room-timeline"]')!;
      frames.length = 0;

      stream(fake, delta("Growing"));
      Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1400 });
      frames.forEach((frame) => frame(0));
      expect(frames.length).toBeGreaterThan(0);
      expect(timeline.scrollTop).toBe(1400);

      scrollTo(1100, 1400);
      act(() => fake.receive(remoteMessage("message-2", "Landed while away")));
      await settle();
      expect(container.textContent).not.toContain("Landed while away");
      expect(pill()?.textContent).toBe("1 new");
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });

  test("only a stream that is reconnecting has dropped anything", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Whole so far"));

    act(() => fake.roomStreams.setState("s1", "connecting"));
    act(() => fake.roomStreams.setState("s1", "connected"));

    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Whole so far");
  });
});
