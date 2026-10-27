import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  EngagementView,
  ReviewView,
  RunView,
  SailEvent,
  SpecMessage,
} from "../../shared/sail-models";
import { fakeRoomStreams } from "../../../test/roomStreams";
import { ToastProvider } from "../components/Toast";
import type { Gateway } from "../gateway";
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

const CODEX_BUILD: RunView = {
  id: "run-1",
  project: "mast",
  spec_id: "s1",
  node: "devbox",
  role: "build",
  agent: "codex",
  status: "running",
  started_at: "2026-07-28T10:00:00Z",
  principal: "codex/run-1",
  owner: "uday",
};

function makeGateway({
  withReview = false,
  reviewStatus = review.status,
  withFindings = true,
  postError,
  reviewGate,
  specEvents = [],
  specEventsError = false,
  globalEvents = [],
  runs = [CODEX_BUILD],
  roomRuns = [],
}: {
  withReview?: boolean;
  reviewStatus?: string;
  withFindings?: boolean;
  postError?: string;
  reviewGate?: Promise<void>;
  specEvents?: SailEvent[];
  specEventsError?: boolean;
  globalEvents?: SailEvent[];
  runs?: RunView[];
  /** The runs listed under any other conversation than the spec `s1`: a home room's members. */
  roomRuns?: RunView[];
} = {}) {
  let messages: SpecMessage[] = [];
  let messagesRefused = false;
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
      if (messagesRefused) {
        return {
          ok: false as const,
          error: { status: 503, code: "unavailable", message: "box unreachable" },
        };
      }
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
    listRuns: async (conversation: string) => {
      calls.runs++;
      return {
        ok: true as const,
        value: { spec: conversation, runs: conversation === "s1" ? runs : roomRuns },
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
    refuseMessages(refused: boolean) {
      messagesRefused = refused;
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

  test("history that fails to load says so with a Retry, never the room's beginning", async () => {
    const fake = makeGateway();
    fake.store(remoteMessage("message-2", "An old word."));
    fake.refuseMessages(true);
    await mount(fake.gateway, "in_progress", "Bulk capture campaign");

    const failure = () => container.querySelector('[data-testid="room-history-error"]');
    expect(failure()?.textContent).toBe("Couldn't load this room's history: box unreachableRetry");
    expect(container.querySelector(".room-beginning")).toBeNull();

    act(() => [...failure()!.querySelectorAll("button")].at(-1)!.click());
    await settle();
    expect(failure()?.textContent).toContain("box unreachable");

    fake.refuseMessages(false);
    act(() => [...failure()!.querySelectorAll("button")].at(-1)!.click());
    await settle();
    expect(failure()).toBeNull();
    expect(container.textContent).toContain("An old word.");
    expect(container.querySelector(".room-beginning")).not.toBeNull();
  });

  test("a room shown in place of one whose history failed starts with no error of its own", async () => {
    const fake = makeGateway();
    fake.refuseMessages(true);
    await mount(fake.gateway);
    expect(container.querySelector('[data-testid="room-history-error"]')).not.toBeNull();

    fake.refuseMessages(false);
    act(() =>
      root.render(
        <ToastProvider>
          <SpecRoom gateway={fake.gateway} specId="s2" roomId="s2" canWrite currentUser="uday" />
        </ToastProvider>,
      ),
    );

    expect(container.querySelector('[data-testid="room-history-error"]')).toBeNull();
  });

  test("history that failed to load is read again when the window takes focus, and on reconnect", async () => {
    const fake = makeGateway();
    fake.store(remoteMessage("message-2", "An old word."));
    fake.refuseMessages(true);
    await mount(fake.gateway);
    const failure = () => container.querySelector('[data-testid="room-history-error"]');

    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(failure()).not.toBeNull();

    fake.refuseMessages(false);
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(failure()).toBeNull();
    expect(container.textContent).toContain("An old word.");

    act(() => root.unmount());
    container.remove();
    fake.refuseMessages(true);
    await mount(fake.gateway);
    act(() => fake.setStream("reconnecting"));
    fake.refuseMessages(false);
    act(() => fake.setStream("connected"));
    await settle();
    expect(failure()).toBeNull();
    expect(container.textContent).toContain("An old word.");
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
  const PRINCIPAL = "claude/run-7";
  const DRAFT = '[data-testid="draft-run-7-7"]';

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
    agent_name: agent === "codex" ? "Codex CLI" : "Claude Code",
    mode: "full",
    engaged_at: "2026-07-28T09:00:00Z",
  });

  type Fake = ReturnType<typeof makeGateway>;
  const stream = (fake: Fake, ...events: SailEvent[]) =>
    act(() => events.forEach((event) => fake.roomStreams.emit(event.spec!, event)));
  const draft = () => container.querySelector<HTMLElement>(DRAFT);
  const occurrences = (text: string) => container.textContent!.split(text).length - 1;
  const pill = () => container.querySelector<HTMLButtonElement>(".room-new-pill");

  /** Lays the timeline out, as an engine would, without telling the room of a scroll. */
  function layOut(scrollTop: number, scrollHeight: number, clientHeight = 100) {
    Object.defineProperties(timeline(), {
      scrollHeight: { configurable: true, value: scrollHeight },
      clientHeight: { configurable: true, value: clientHeight },
      scrollTop: { configurable: true, writable: true, value: scrollTop },
    });
  }

  /** Tells the room of a scroll, as an engine does a frame after the reader's place changed. */
  const tellScroll = () =>
    act(() => timeline().dispatchEvent(new Event("scroll", { bubbles: true })));

  function scrollTo(scrollTop: number, scrollHeight = 1000, clientHeight = 100) {
    layOut(scrollTop, scrollHeight, clientHeight);
    tellScroll();
  }

  /**
   * Lays the timeline out as an engine does: as tall as what is drawn makes it, with the reader
   * held within it, so a room that shrinks under them leaves them resting on its new end.
   */
  function layOutBy(scrollHeight: () => number) {
    let top = 0;
    Object.defineProperties(timeline(), {
      scrollHeight: { configurable: true, get: scrollHeight },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: {
        configurable: true,
        get: () => (top = Math.min(top, Math.max(0, scrollHeight() - 100))),
        set: (place: number) => void (top = place),
      },
    });
  }

  /** The frames the room asks for, run when a test paints: a frame is where the room keeps the reader's place. */
  const frames: FrameRequestCallback[] = [];
  const paint = () => act(() => frames.splice(0).forEach((frame) => frame(0)));
  const timeline = () => container.querySelector<HTMLElement>('[data-testid="room-timeline"]')!;
  let requestFrame: typeof globalThis.requestAnimationFrame;

  beforeEach(() => {
    frames.length = 0;
    requestFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (frame) => frames.push(frame);
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = requestFrame;
  });

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

  test("a room swapped in place forgets the replies the reader had not seen in the old one", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, "room-a");
    scrollTo(900);
    stream(fake, live("agent_text_delta", { text: "Room A's turn." }, "room-a"));
    scrollTo(400, 1400);
    stream(fake, live("agent_turn_ended", { is_error: false, message_id: "message-7" }, "room-a"));
    act(() => fake.receive(reply("Room A's turn.")));
    await settle();
    expect(pill()?.textContent).toBe("1 new");

    act(() =>
      root.render(
        <ToastProvider>
          <SpecRoom gateway={fake.gateway} specId="s1" roomId="room-b" canWrite />
        </ToastProvider>,
      ),
    );
    await settle();

    expect(pill()).toBeNull();
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
    expect(draft()?.querySelector(".room-message-head strong")?.textContent).toBe("claude");
    expect(draft()?.querySelector(".room-avatar.is-agent")?.getAttribute("aria-label")).toBe(
      `${PRINCIPAL}, agent`,
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

  test("a turn that begins and ends having said nothing leaves no dots behind", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    stream(fake, live("agent_turn_began"));
    expect(draft()?.querySelector(".typing-dots")).not.toBeNull();

    stream(fake, turnEnded());
    expect(draft()).toBeNull();
    expect(container.querySelector(".typing-dots")).toBeNull();
  });

  const memberRun = (agent: string, agent_name: string, id = "run-7"): RunView => ({
    id,
    project: "mast",
    node: "devbox",
    role: "room-full",
    agent,
    agent_name,
    status: "running",
    started_at: "2026-07-28T10:00:00Z",
    principal: `${agent === "codex" ? "codex" : "claude"}/${id}`,
  });
  const dots = () => container.querySelectorAll(".typing-dots");
  const label = (row: Element | null) => row?.querySelector(".room-message-head strong")?.textContent;

  test("a member is shown working once, from its turn's beginning to its end, and never between turns", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    enterMessage("hello");
    await settle();
    expect(dots()).toHaveLength(0);

    stream(fake, live("agent_turn_began"));
    expect(dots()).toHaveLength(1);
    expect(draft()?.querySelector(".typing-dots")).not.toBeNull();

    stream(fake, delta("Hi."), turnEnded({ message_id: "message-7" }));
    expect(dots()).toHaveLength(0);
    act(() => fake.receive(reply("Hi.")));
    await settle();
    expect(draft()).toBeNull();
    expect(dots()).toHaveLength(0);

    for (const turn of [8, 9]) {
      stream(fake, live("agent_turn_began", { turn }));
      expect(dots()).toHaveLength(1);
      stream(fake, live("agent_turn_ended", { is_error: false, turn }));
      expect(dots()).toHaveLength(0);
    }
    expect(container.querySelector(".roster-chip, .presence-chip")).toBeNull();
  });

  test("a room opened mid-turn shows the member working, and the draft fills from the next delta", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    stream(fake, live("agent_turn_state", { open: true }));
    expect(draft()?.querySelector(".typing-dots")).not.toBeNull();

    stream(fake, delta("Picking up."));
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Picking up.");
  });

  test("a stream that drops across a turn's end is told the message, and the draft yields to it", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    act(() => fake.receive(reply("Half a sentence, whole.")));
    await settle();
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Half a sent … ");

    act(() => fake.roomStreams.setState("s1", "connected"));
    stream(fake, live("agent_turn_state", { open: false, message_id: "message-7", is_error: false }));
    await settle();

    expect(draft()).toBeNull();
    expect(occurrences("Half a sentence, whole.")).toBe(1);
  });

  test("a frame naming a turn that ended blank, or no member at all, leaves no draft", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    stream(fake, delta("Half a sent"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));

    stream(fake, { ...live("agent_turn_state"), data: { open: false } });

    expect(draft()).toBeNull();
  });

  test("an agent is named by its harness on its replies and its working row, whatever its principal's prefix", async () => {
    const fake = makeGateway({ runs: [memberRun("claude-code", "Claude Code")] });
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));
    act(() => fake.receive({ ...reply("Hello."), author: "claude/run-7" }));
    await settle();

    const replyRow = container.querySelector('[data-testid^="message-group-"]');
    expect(label(replyRow)).toBe("Claude Code");

    stream(fake, live("agent_turn_began", { turn: 8, principal: "claude/run-7" }));
    const working = container.querySelector('[data-testid="draft-run-7-8"]');
    expect(label(working)).toBe("Claude Code");
    expect(working?.querySelector(".typing-dots")?.getAttribute("aria-label")).toBe(
      "Claude Code is typing",
    );
  });

  test("a turn whose run the room has not read yet is named by the engaged member's harness", async () => {
    const fake = makeGateway({ runs: [] });
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    stream(fake, live("agent_turn_began", { principal: "claude/run-7" }));

    expect(label(draft())).toBe("Claude Code");
  });

  test("a Codex member is named Codex CLI and behaves the same", async () => {
    const fake = makeGateway({ runs: [memberRun("codex", "Codex CLI")] });
    await mount(fake.gateway, undefined, undefined, undefined, engaged("codex"));
    const said = (more: Record<string, unknown>) => ({ principal: "codex/run-7", ...more });

    stream(fake, live("agent_turn_began", said({})), live("agent_text_delta", said({ text: "Done." })));
    expect(label(draft())).toBe("Codex CLI");
    expect(dots()).toHaveLength(1);

    stream(fake, live("agent_turn_ended", said({ is_error: false, message_id: "message-7" })));
    act(() => fake.receive({ ...reply("Done."), author: "codex/run-7" }));
    await settle();

    expect(draft()).toBeNull();
    expect(dots()).toHaveLength(0);
    expect(label(container.querySelector('[data-testid^="message-group-"]'))).toBe("Codex CLI");
  });

  test("a failure is told in the harness's name alone, the run's owner staying on the row's head", async () => {
    const fake = makeGateway({ runs: [{ ...memberRun("claude-code", "Claude Code"), owner: "pyam" }] });
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    act(() => fake.receive({ ...reply("Not logged in"), author: "claude/run-7", error: true }));
    await settle();

    expect(label(container.querySelector('[data-testid^="message-group-"]'))).toBe(
      "Claude Code (for pyam)",
    );
    expect(
      container.querySelector('[data-testid="room-message-message-7"] .room-turn-failed')
        ?.textContent,
    ).toBe("Claude Code couldn't answer");
  });

  test("a principal of another agent than the engaged one keeps its own name until its run is read", async () => {
    const fake = makeGateway({ runs: [] });
    await mount(fake.gateway, undefined, undefined, undefined, engaged("codex"));

    act(() => fake.receive({ ...reply("Fixed."), author: "claude/fix-9" }));
    await settle();

    expect(label(container.querySelector('[data-testid^="message-group-"]'))).toBe("claude");
  });

  test("a failed turn's line comes before its words, live as after its message lands", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    stream(fake, live("agent_turn_began"), delta("Half a thought"));
    stream(fake, turnEnded({ is_error: true, reason: "out of memory" }));

    const parts = [...(draft()?.querySelectorAll(".room-turn-failed, .room-draft-text") ?? [])];
    expect(parts.map((part) => part.className.split(" ")[0])).toEqual([
      "room-turn-failed",
      "room-message-body",
    ]);
  });

  test("a failed turn reads as failed in the agent's own words, live and after a reload", async () => {
    const fake = makeGateway({ runs: [memberRun("claude-code", "Claude Code")] });
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));
    const failed: SpecMessage = {
      ...reply("Not logged in · Please run /login"),
      author: "claude/run-7",
      error: true,
    };

    stream(fake, live("agent_turn_began", { principal: "claude/run-7" }));
    stream(fake, turnEnded({ principal: "claude/run-7", is_error: true, message_id: "message-7" }));
    act(() => fake.receive(failed));
    await settle();

    const shown = () => container.querySelector('[data-testid="room-message-message-7"]');
    expect(shown()?.classList.contains("is-error")).toBe(true);
    expect(shown()?.classList.contains("is-failed")).toBe(false);
    expect(shown()?.querySelector(".room-turn-failed")?.textContent).toBe(
      "Claude Code couldn't answer",
    );
    expect(shown()?.textContent).toContain("Not logged in · Please run /login");
    expect(container.textContent).not.toContain("success");
    expect(container.textContent).not.toContain("ended early");

    act(() => root.unmount());
    container.remove();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));
    expect(shown()?.querySelector(".room-turn-failed")?.textContent).toBe(
      "Claude Code couldn't answer",
    );
  });

  test("a named failure keeps its reason once its message takes the draft's place, whichever arrives first", async () => {
    const failed: SpecMessage = { ...reply("Stopped after 30 turns."), error: true };
    const told = () =>
      container.querySelector('[data-testid="room-message-message-7"] .room-turn-failed')
        ?.textContent;
    const ends = turnEnded({ is_error: true, reason: "error_max_turns", message_id: "message-7" });

    const endFirst = makeGateway();
    await mount(endFirst.gateway, undefined, undefined, undefined, engaged("claude-code"));
    stream(endFirst, live("agent_turn_began"), ends);
    act(() => endFirst.receive(failed));
    await settle();
    expect(draft()).toBeNull();
    expect(told()).toBe("Claude Code couldn't answer · error_max_turns");

    act(() => root.unmount());
    container.remove();
    const messageFirst = makeGateway();
    await mount(messageFirst.gateway, undefined, undefined, undefined, engaged("claude-code"));
    stream(messageFirst, live("agent_turn_began"));
    act(() => messageFirst.receive(failed));
    await settle();
    stream(messageFirst, ends);
    await settle();
    expect(draft()).toBeNull();
    expect(told()).toBe("Claude Code couldn't answer · error_max_turns");
  });

  test("a spec's room names a reply its home room's member wrote by that member's harness", async () => {
    const fake = makeGateway({ runs: [], roomRuns: [memberRun("claude-code", "Claude Code")] });
    fake.store({ ...reply("Earlier answer."), author: "claude/run-7" });
    await mount(fake.gateway, undefined, undefined, "home-room", engaged("codex"));

    expect(label(container.querySelector('[data-testid^="message-group-"]'))).toBe("Claude Code");
  });

  test("a failure the box names is told with its reason, and an answer is a plain reply", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    stream(fake, turnEnded({ is_error: true, reason: "error_max_turns" }));
    expect(draft()?.querySelector(".room-turn-failed")?.textContent).toBe(
      "Claude Code couldn't answer · error_max_turns",
    );

    stream(fake, live("agent_turn_began", { turn: 8 }), live("agent_turn_ended", { turn: 8, message_id: "message-8", is_error: false }));
    act(() => fake.receive({ ...reply("Fine."), id: "message-8" }));
    await settle();
    const answer = container.querySelector('[data-testid="room-message-message-8"]');
    expect(answer?.classList.contains("is-error")).toBe(false);
    expect(container.querySelector(".room-turn-failed")).toBeNull();
  });

  test("a stream that drops says nothing of a member working until the turn is heard from again", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    stream(fake, live("agent_turn_began"));
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    expect(draft()).toBeNull();

    stream(fake, delta("Half a sent"));
    expect(draft()?.querySelector(".typing-dots")).not.toBeNull();
    act(() => fake.roomStreams.setState("s1", "reconnecting"));
    expect(draft()?.querySelector(".room-draft-text")?.textContent).toBe("Half a sent … ");
    expect(draft()?.querySelector(".typing-dots")).toBeNull();

    stream(fake, delta("ence."));
    expect(draft()?.querySelector(".typing-dots")).not.toBeNull();
  });

  test("a turn that failed before it wrote anything says so, with no dots", async () => {
    const fake = makeGateway();
    await mount(fake.gateway, undefined, undefined, undefined, engaged("claude-code"));

    stream(fake, live("agent_turn_began"), turnEnded({ is_error: true, reason: "out of memory" }));

    expect(draft()?.querySelector(".typing-dots")).toBeNull();
    expect(draft()?.querySelector(".room-turn-failed")?.textContent).toBe(
      "Claude Code couldn't answer · out of memory",
    );
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
        principal: "claude/run-8",
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
    scrollTo(500);

    stream(fake, delta("The full reply."));
    expect(draft()).toBeNull();
    expect(pill()?.textContent).toBe("1 new");

    scrollTo(0, 900);
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

  test("a reader who scrolls up while a turn is written keeps its draft; its message takes the draft's place and the pill tells them of it", async () => {
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
    expect(pill()?.textContent).toBe("1 new");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === 1)).toBe(true);

    act(() => fake.receive(remoteMessage("message-8", "Landed while away")));
    await settle();
    expect(container.textContent).not.toContain("Landed while away");
    expect(pill()?.textContent).toBe("2 new");

    act(() => pill()!.click());
    expect(container.textContent).toContain("Landed while away");
    expect(pill()).toBeNull();
  });

  test("a turn that begins while the reader is away is on the pill once it has written something", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    scrollTo(900);
    scrollTo(0);

    stream(fake, live("agent_turn_began"));
    expect(draft()).toBeNull();
    expect(pill()).toBeNull();

    stream(fake, delta("Something."));
    expect(pill()?.textContent).toBe("1 new");

    stream(fake, turnEnded());
    expect(pill()).toBeNull();
  });

  test("a reply the reader saw arrive before they left is not news when its turn's end names it", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("The full reply."));
    act(() => fake.receive(reply("The full reply, posted.")));
    await settle();
    expect(container.textContent).toContain("The full reply, posted.");

    scrollTo(400, 1400);
    stream(fake, turnEnded({ message_id: "message-7" }));

    expect(draft()).toBeNull();
    expect(pill()).toBeNull();
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
    expect(pill()?.textContent).toBe("1 new");
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

    scrollTo(699, 800);
    act(() => fake.receive(remoteMessage("message-2", "Landed after the room shrank")));
    await settle();
    expect(container.textContent).toContain("Landed after the room shrank");
    expect(pill()).toBeNull();

    scrollTo(698, 800);
    act(() => fake.receive(remoteMessage("message-3", "Landed a nudge away")));
    await settle();
    expect(container.textContent).not.toContain("Landed a nudge away");
    expect(pill()?.textContent).toBe("1 new");
  });

  test("a reader at the latest is kept there as the draft grows, and their move up is told from the room's own", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    paint();

    stream(fake, delta("Growing"));
    layOut(900, 1400);
    paint();
    expect(timeline().scrollTop).toBe(1400);

    scrollTo(1100, 1400);
    act(() => fake.receive(remoteMessage("message-2", "Landed while away")));
    await settle();
    expect(container.textContent).not.toContain("Landed while away");
    expect(pill()?.textContent).toBe("1 new");
  });

  test("a reader who moves up before the room's own scroll runs is not pulled back", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    scrollTo(900);
    paint();

    stream(fake, delta("Growing"));
    scrollTo(700, 1400);
    paint();

    expect(timeline().scrollTop).toBe(700);
  });

  test("a reader left at the very end by what was below them shrinking, with no scroll to tell of it, follows again", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("A tall turn."));
    scrollTo(0, 1400);

    stream(fake, turnEnded({ message_id: "message-7" }));
    layOut(0, 101);
    act(() => fake.receive(reply("Short.")));
    await settle();

    stream(fake, live("agent_text_delta", { text: "The next turn.", turn: 8 }));
    expect(container.querySelector('[data-testid="draft-run-7-8"]')?.textContent).toContain(
      "The next turn.",
    );
    expect(pill()).toBeNull();
  });

  test("a reader left near the end, but not at it, is still away", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("A tall turn."));
    scrollTo(0, 1400);

    stream(fake, turnEnded({ message_id: "message-7" }));
    layOut(0, 102);
    act(() => fake.receive(reply("Short.")));
    await settle();

    expect(pill()?.textContent).toBe("1 new");
    stream(fake, live("agent_text_delta", { text: "The next turn.", turn: 8 }));
    expect(container.querySelector('[data-testid="draft-run-7-8"]')).toBeNull();
    expect(pill()?.textContent).toBe("2 new");
  });

  test("a reader the room finds resting at the very end has nothing left behind the pill", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("A tall turn."));
    scrollTo(0, 1400);
    act(() => fake.receive(remoteMessage("message-2", "Behind the pill")));
    await settle();
    expect(pill()?.textContent).toBe("1 new");

    stream(fake, turnEnded({ message_id: "message-7" }));
    layOut(0, 100);
    act(() => fake.receive(reply("Short.")));
    await settle();

    expect(container.textContent).toContain("Behind the pill");
    expect(pill()).toBeNull();
  });

  test("a reader who never moved keeps following when a reply shrinks the room and the next turn grows it before that scroll is told", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    const next = () => container.querySelector('[data-testid="draft-run-7-8"]');
    layOutBy(() => 400 + (draft() ? 1000 : 0) + (next() ? 300 : 0));
    stream(fake, delta("A tall turn."));
    paint();
    expect(timeline().scrollTop).toBe(1300);

    stream(fake, turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("Short.")));
    await settle();
    expect(timeline().scrollTop).toBe(300);
    stream(fake, live("agent_text_delta", { text: "The next turn.", turn: 8 }));
    tellScroll();
    paint();

    expect(timeline().scrollTop).toBe(600);
    act(() => fake.receive(remoteMessage("message-2", "Landed after")));
    await settle();
    expect(container.textContent).toContain("Landed after");
    expect(pill()).toBeNull();
  });

  test("a reader the engine moves short of the end, as the room draws a reply over a draft, has not left", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    const next = () => container.querySelector('[data-testid="draft-run-7-8"]');
    let top = 0;
    let anchored = false;
    Object.defineProperties(timeline(), {
      scrollHeight: { configurable: true, get: () => (draft() ? 1400 : 400) + (next() ? 300 : 0) },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: {
        configurable: true,
        get: () => {
          if (!draft() && next() && !anchored) {
            anchored = true;
            top = 200;
          }
          return top;
        },
        set: (place: number) => void (top = place),
      },
    });
    stream(fake, delta("A tall turn."));
    paint();
    expect(timeline().scrollTop).toBe(1400);

    stream(fake, turnEnded({ message_id: "message-7" }));
    stream(fake, live("agent_text_delta", { text: "The next turn.", turn: 8 }));
    act(() => fake.receive(reply("Short.")));
    await settle();
    expect(timeline().scrollTop).toBe(200);
    tellScroll();
    paint();

    expect(timeline().scrollTop).toBe(700);
  });

  test("a reader the room finds resting at the very end still follows once that scroll is told, after what the pill released has grown the room", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    layOutBy(() => 400 + (draft() ? 1000 : 0) + (container.textContent!.includes("Behind the pill") ? 60 : 0));
    stream(fake, delta("A tall turn."));
    paint();
    timeline().scrollTop = 400;
    tellScroll();
    act(() => fake.receive(remoteMessage("message-2", "Behind the pill")));
    await settle();
    expect(pill()?.textContent).toBe("1 new");

    stream(fake, turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("Short.")));
    await settle();
    expect(container.textContent).toContain("Behind the pill");
    expect(pill()).toBeNull();

    tellScroll();
    paint();
    expect(timeline().scrollTop).toBe(360);
  });

  test("a window that grows taller while a turn is written has not moved a reader who follows", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    paint();

    layOut(850, 1100, 150);
    stream(fake, delta("Written as the window grew."));
    tellScroll();
    paint();

    expect(timeline().scrollTop).toBe(1100);
  });

  test("a reader who was away when the room left the screen is still away when it returns", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    scrollTo(0);
    layOut(0, 0, 0);

    act(() => fake.receive(remoteMessage("message-2", "Landed while hidden")));
    await settle();
    layOut(0, 1000);
    paint();

    expect(timeline().scrollTop).toBe(0);
    expect(container.textContent).not.toContain("Landed while hidden");
    expect(pill()?.textContent).toBe("1 new");
  });

  test("a room that is not on screen keeps no place: the reader's first move up after it returns is still told", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    paint();

    layOut(0, 0, 0);
    stream(fake, delta("Written while hidden."));
    paint();
    expect(timeline().scrollTop).toBe(0);

    scrollTo(800, 1400);
    act(() => fake.receive(remoteMessage("message-2", "Landed while away")));
    await settle();
    expect(container.textContent).not.toContain("Landed while away");
    expect(pill()?.textContent).toBe("1 new");
  });

  test("moving down brings the reader back once within reach of the latest, not before", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    scrollTo(800, 1400);

    scrollTo(1251, 1400);
    act(() => fake.receive(remoteMessage("message-2", "Landed just out of reach")));
    await settle();
    expect(container.textContent).not.toContain("Landed just out of reach");
    expect(pill()?.textContent).toBe("1 new");

    scrollTo(1252, 1400);
    expect(container.textContent).toContain("Landed just out of reach");
    expect(pill()).toBeNull();
  });

  test("a reply that takes a draft's place leaves the rest behind the pill, and is drawn in its own time", async () => {
    const fake = makeGateway();
    fake.receive(remoteMessage("message-old", "Already visible"));
    await mount(fake.gateway);
    scrollTo(900);
    stream(fake, delta("The full reply."));
    act(() =>
      fake.receive({ ...remoteMessage("message-9", "Said later"), created_at: "2026-07-28T10:05:00Z" }),
    );
    await settle();
    scrollTo(400, 1400);
    act(() =>
      fake.receive({ ...remoteMessage("message-8", "Behind the pill"), created_at: "2026-07-28T10:04:00Z" }),
    );
    await settle();

    stream(fake, turnEnded({ message_id: "message-7" }));
    act(() => fake.receive(reply("The full reply.")));
    await settle();

    expect(container.textContent).not.toContain("Behind the pill");
    expect(pill()?.textContent).toBe("2 new");
    const drawn = () =>
      [...container.querySelectorAll('[data-testid^="room-message-"]')].map((row) =>
        row.getAttribute("data-testid"),
      );
    expect(drawn()).toEqual([
      "room-message-message-old",
      "room-message-message-7",
      "room-message-message-9",
    ]);

    act(() => pill()!.click());
    expect(drawn()).toEqual([
      "room-message-message-old",
      "room-message-message-7",
      "room-message-message-8",
      "room-message-message-9",
    ]);
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
