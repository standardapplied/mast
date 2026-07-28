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

const remoteMessage = (id: string, body: string): SpecMessage => ({
  id,
  spec_id: "s1",
  author: "codex/run-1",
  body,
  created_at: "2026-07-28T10:02:00Z",
});

function makeGateway({ withReview = false, postError }: { withReview?: boolean; postError?: string } = {}) {
  let messages: SpecMessage[] = [];
  const listeners = new Set<(event: SailEvent) => void>();
  const calls = { posts: [] as string[], approved: [] as string[], dismissed: [] as string[] };
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
    recentEvents: async () => ({
      ok: true as const,
      value: { limit: 100, returned: 0, events: [] },
    }),
    specReviews: async () => ({
      ok: true as const,
      value: { spec_id: "s1", reviews: withReview ? [review] : [] },
    }),
    reviewDetail: async () => ({
      ok: true as const,
      value: {
        review,
        findings: [
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
        ],
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
  };
  return {
    gateway: gateway as unknown as Gateway,
    calls,
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
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {});
}

async function mount(gateway: Gateway) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <SpecRoom
          gateway={gateway}
          specId="s1"
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
    expect(container.textContent).toContain("codex/run-1 (for uday)");
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
});
