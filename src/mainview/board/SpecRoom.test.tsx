import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ReviewView,
  SailEvent,
  SpecMessage,
} from "../../shared/sail-models";
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
    approved: [] as string[],
    dismissed: [] as string[],
    specEvents: [] as { since?: number; limit?: number }[],
    recent: 0,
  };
  const selectedReview = { ...review, status: reviewStatus };
  const gateway = {
    listSpecMessages: async () => ({
      ok: true as const,
      value: { spec_id: "s1", messages, total: messages.length },
    }),
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
    specEvents: async (_id: string, options: { since?: number; limit?: number } = {}) => {
      calls.specEvents.push(options);
      if (specEventsError) {
        return {
          ok: false as const,
          error: { status: 405, code: "method_not_allowed", message: "old sail" },
        };
      }
      const scoped = history.filter(
        (event) => options.since === undefined || (event.id ?? 0) > options.since,
      );
      return {
        ok: true as const,
        value: { spec: "s1", limit: options.limit ?? 100, returned: scoped.length, events: scoped },
      };
    },
    specReviews: async () => {
      if (reviewGate) await reviewGate;
      return {
        ok: true as const,
        value: { spec_id: "s1", reviews: withReview ? [selectedReview] : [] },
      };
    },
    reviewDetail: async () => ({
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
    }),
    listRuns: async () => ({
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
    }),
    approveReview: async (reviewId: string) => {
      calls.approved.push(reviewId);
      return { ok: true as const, value: { review_id: reviewId, approved: true } };
    },
    dismissFinding: async (reviewId: string, findingId: string) => {
      calls.dismissed.push(`${reviewId}:${findingId}`);
      return { ok: true as const, value: { finding_id: findingId, dismissed: true } };
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
    setHistory(events: SailEvent[]) {
      history = events;
    },
    setStream(stream: string) {
      statusListeners.forEach((listener) => listener({ stream }));
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
          data: { message_id: message.id, preview: message.body },
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

async function mount(gateway: Gateway, specStatus?: string, specTitle?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <SpecRoom
          gateway={gateway}
          specId="s1"
          specStatus={specStatus}
          specTitle={specTitle}
          canWrite
          currentUser="uday"
          onOpenLog={() => {}}
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
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
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

  test("approves and dismisses inline, recording each decision in the timeline", async () => {
    const fake = makeGateway({ withReview: true });
    await mount(fake.gateway);

    expect(container.querySelector(".spec-room > .card")).toBeNull();
    expect(container.querySelectorAll(".room-review-card").length).toBe(1);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="review-row-review-1"]')!
        .click(),
    );
    const dismiss = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss",
    )!;
    act(() => dismiss.click());
    await settle();
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve review",
    )!;
    act(() => approve.click());
    await settle();

    expect(fake.calls.dismissed).toEqual(["review-1:finding-1"]);
    expect(fake.calls.approved).toEqual(["review-1"]);
    expect(container.textContent).toContain("uday dismissed finding finding-1");
    expect(container.textContent).toContain("uday approved review review-1");
  });

  test("approve review is a primary action only while the spec is in review", async () => {
    const inReview = makeGateway({ withReview: true });
    await mount(inReview.gateway, "review");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="review-row-review-1"]')!
        .click(),
    );
    const primary = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve review",
    )!;
    expect(primary.className).toContain("btn-primary");
    act(() => root.unmount());
    container.remove();

    const merged = makeGateway({ withReview: true });
    await mount(merged.gateway, "awaiting_merge");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="review-row-review-1"]')!
        .click(),
    );
    const quiet = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve review",
    )!;
    expect(quiet.className).toContain("btn-ghost");
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
            onOpenLog={() => {}}
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
    expect(container.querySelector(".room-composer-hint")?.textContent).toBe("⏎ to send");

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
            onOpenLog={() => {}}
          />
        </ToastProvider>,
      ),
    );
    await settle();

    expect(container.querySelector('[aria-label="Message this room"]')).toBeNull();
    expect(container.querySelector('[aria-label="Send"]')).toBeNull();
    expect(container.querySelector(".room-readonly")?.textContent).toBe(
      "This room is done — read-only.",
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

    expect(fake.calls.specEvents).toEqual([{ limit: 100 }, { since: 5 }]);
    const rows = [...container.querySelectorAll(".room-system-row")];
    expect(rows.filter((row) => /dispatched/i.test(row.textContent ?? "")).length).toBe(1);
    expect(rows.some((row) => /agent stopped/i.test(row.textContent ?? ""))).toBe(true);
  });
});
