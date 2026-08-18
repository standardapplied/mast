import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GlobalSpecView, RunView, SailEvent, StopRunResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { ToastProvider } from "../components/Toast";
import type { Gateway } from "../gateway";
import { SpecDetail } from "./SpecDetail";

/**
 * Anti-flicker contract for the detail page: readiness verdicts and
 * empty-states must not render before the data that justifies them exists,
 * and an event-driven reload must never blank sections that were already on
 * screen.
 */

let root: Root;
let container: HTMLElement;

const spec = (partial: Partial<GlobalSpecView> & Pick<GlobalSpecView, "id">): GlobalSpecView => ({
  project: "chorus",
  title: partial.id,
  status: "pending",
  priority: 0,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-09T00:00:00Z",
  ...partial,
});

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeGateway(
  status: GlobalSpecView["status"] = "pending",
  assignee?: string,
  opts: { noFdeRoster?: boolean; capabilities?: string[] } = {},
) {
  const main = spec({ id: "s1", depends_on: ["dep-a"], status, assignee });
  const dep = spec({ id: "dep-a", status: "done" });
  const listeners = new Set<(e: SailEvent) => void>();
  const updates: unknown[] = [];
  const stopCalls: string[] = [];
  const getSpecCalls = { count: 0 };
  let enrichGate: Promise<void> = Promise.resolve();
  let revisions = [{ rev: 1, recorded_at: "2026-07-09T00:00:00Z", origin: "create", deleted: false }];
  let runs: RunView[] = [];
  let stopResult: SailResult<StopRunResponse> = {
    ok: true,
    value: { run_id: "run-b1", stopped: true, spec_cancelled: true },
  };

  const gateway = {
    whoami: async () => ({
      ok: true as const,
      value: {
        name: "uday",
        fde: "uday",
        role: "admin" as const,
        capabilities: opts.capabilities ?? ["read", "write", "admin"],
      },
    }),
    listFdes: async () =>
      opts.noFdeRoster
        ? {
            ok: false as const,
            error: { status: 404, code: "not_found", message: "no such endpoint" },
          }
        : {
            ok: true as const,
            value: {
              fdes: [
                { handle: "sumesh", display_name: "Sumesh P", role: "member" },
                { handle: "uday", display_name: "Uday K", role: "admin" },
              ],
            },
          },
    updateSpec: async (_id: string, request: unknown) => {
      updates.push(request);
      return { ok: true as const, value: { spec: main }, etag: '"e2"' };
    },
    getSpec: async () => {
      getSpecCalls.count++;
      return { ok: true as const, value: { spec: main }, etag: '"e1"' };
    },
    listRuns: async () => ({ ok: true as const, value: { spec: "s1", runs } }),
    stopRun: async (runId: string) => {
      stopCalls.push(runId);
      return stopResult;
    },
    getSpecContent: async () => ({
      ok: true as const,
      value: { spec_id: "s1", body: "# body", plan: "" },
    }),
    specHistory: async () => {
      await enrichGate;
      return { ok: true as const, value: { spec_id: "s1", revisions, total: revisions.length } };
    },
    specReviews: async () => {
      await enrichGate;
      return {
        ok: true as const,
        value: {
          spec_id: "s1",
          reviews:
            status === "review"
              ? [
                  {
                    id: "rev-1",
                    spec_id: "s1",
                    iteration: 1,
                    status: "pending_decision",
                    created_at: "2026-07-14T10:00:00Z",
                    stages: [
                      {
                        id: "st-1",
                        name: "correctness",
                        stage_type: "checker",
                        status: "completed",
                        finding_count: 1,
                      },
                    ],
                  },
                ]
              : [],
        },
      };
    },
    listSpecMessages: async () => ({
      ok: true as const,
      value: { spec_id: "s1", messages: [], total: 0 },
    }),
    postSpecMessage: async (_id: string, request: { body: string }) => ({
      ok: true as const,
      value: {
        message: {
          id: "m-1",
          spec_id: "s1",
          author: "uday",
          body: request.body,
          created_at: "2026-07-14T10:00:00Z",
        },
      },
    }),
    recentEvents: async () => ({
      ok: true as const,
      value: { limit: 100, returned: 0, events: [] },
    }),
    specEvents: async (id: string) => ({
      ok: true as const,
      value: { spec: id, limit: 100, returned: 0, events: [] },
    }),
    reviewDetail: async (id: string) => ({
      ok: true as const,
      value: {
        review: {
          id,
          spec_id: "s1",
          iteration: 1,
          status: "pending_decision",
          created_at: "2026-07-14T10:00:00Z",
          stages: [],
        },
        findings: [
          {
            id: "f-1",
            severity: "HIGH" as const,
            category: "correctness",
            file: "src/x.ts",
            line_start: 3,
            line_end: 3,
            title: "Off-by-one in retry cap",
            description: "The loop retries one time fewer than configured.",
            confidence: 0.9,
            resolution: "OPEN" as const,
          },
        ],
      },
    }),
    approveReview: async (reviewId: string) => ({
      ok: true as const,
      value: { review_id: reviewId, approved: true },
    }),
    dismissFinding: async (_reviewId: string, findingId: string) => ({
      ok: true as const,
      value: { finding_id: findingId, dismissed: true },
    }),
    listSpecs: async () => {
      await enrichGate;
      return { ok: true as const, value: { specs: [main, dep], total: 2 } };
    },
    onEvent: (l: (e: SailEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onConnectionStatus: () => () => {},
  };
  return {
    gateway: gateway as unknown as Gateway,
    updates,
    stopCalls,
    getSpecCalls,
    setRuns: (r: RunView[]) => (runs = r),
    setStopResult: (r: SailResult<StopRunResponse>) => (stopResult = r),
    setEnrichGate: (gate: Promise<void>) => (enrichGate = gate),
    setRevisions: (r: typeof revisions) => (revisions = r),
    emit: (e: Partial<SailEvent>) =>
      listeners.forEach((l) =>
        l({ v: 1, ts: "", project: "chorus", type: "spec_status_changed", agent: "a", host: "h", ...e } as SailEvent),
      ),
  };
}

async function mount(gateway: Gateway) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider>
        <SpecDetail
          gateway={gateway}
          specId="s1"
          onOpenSpec={() => {}}
          onBack={() => {}}
          eventDebounceMs={0}
        />
      </ToastProvider>,
    ),
  );
  await settle();
}

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {});
  await act(async () => {});
};

const text = () => container.textContent ?? "";

beforeEach(() => {
  localStorage.removeItem("mast.room.details.rooms.open");
  localStorage.removeItem("mast.room.details.board.open");
  localStorage.removeItem("mast.room.details.width");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SpecDetail anti-flicker", () => {
  test("board deep-links default details open and remember an explicit close", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);

    expect(container.querySelector(".room-details-drawer")).not.toBeNull();
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="details-toggle"]')?.click(),
    );
    expect(container.querySelector(".room-details-drawer")).toBeNull();
    expect(localStorage.getItem("mast.room.details.board.open")).toBe("false");
    expect(container.querySelector(".room-header-title")?.textContent).toBe("s1");
    expect(
      container.querySelector(".room-header-eyebrow")?.textContent,
      "the stable spec id shows above the human title",
    ).toBe("s1");

    act(() => root.unmount());
    container.remove();
    await mount(fake.gateway);
    expect(container.querySelector(".room-details-drawer")).toBeNull();
  });

  test("the beginning marker shows on load; review enrichment fills in after", async () => {
    const fake = makeGateway();
    const gate = deferred<void>();
    fake.setEnrichGate(gate.promise);
    await mount(fake.gateway);

    expect(text()).toContain("s1");
    expect(container.querySelector('[data-testid="blocked-banner"]')).toBeNull();
    expect(
      text(),
      "the beginning marker is the room's start — always valid, shown as soon as it loads",
    ).toContain("the beginning of");
    expect(text(), "review data waits for enrichment, never guessed").not.toContain("rev 1");

    await act(async () => gate.resolve());
    await settle();

    expect(container.querySelector('[data-testid="blocked-banner"]')).toBeNull();
    expect(text()).toContain("rev 1");
  });

  test("an event-driven reload keeps loaded sections on screen", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    expect(text()).toContain("rev 1");

    const gate = deferred<void>();
    fake.setEnrichGate(gate.promise);
    fake.setRevisions([
      { rev: 2, recorded_at: "2026-07-10T00:00:00Z", origin: "update", deleted: false },
      { rev: 1, recorded_at: "2026-07-09T00:00:00Z", origin: "create", deleted: false },
    ]);
    await act(async () => fake.emit({ spec: "s1" }));
    await settle();

    expect(text()).toContain("rev 1");
    expect(text()).toContain("status changed");

    await act(async () => gate.resolve());
    await settle();
    expect(text()).toContain("rev 2");
  });

  test("a review spec offers Re-dispatch and opens the dialog in restart mode", async () => {
    const fake = makeGateway("review");
    await mount(fake.gateway);

    const action = container.querySelector<HTMLButtonElement>('[data-testid="detail-dispatch"]');
    expect(action?.textContent).toBe("Re-dispatch");

    act(() => action?.click());
    await settle();
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Re-dispatch s1");
    expect(text()).toContain("Re-dispatch resets s1 to pending and relaunches on its prior branch.");
    expect(text()).not.toContain("Only pending specs can be dispatched");
  });

  test("a pending spec keeps the plain Dispatch action", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    expect(container.querySelector('[data-testid="detail-dispatch"]')?.textContent).toBe("Dispatch");
  });

  test("a member's write credential dispatches from the detail — no local admin gate", async () => {
    const fake = makeGateway("pending", undefined, { capabilities: ["read", "write"] });
    await mount(fake.gateway);

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="detail-dispatch"]')?.click());
    await settle();

    expect(container.querySelector('[data-testid="dispatch-role"]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="dispatch-go"]')?.disabled,
    ).toBe(false);
  });

  test("own in-progress spec: the log button is enabled", async () => {
    const fake = makeGateway("in_progress", "uday");
    await mount(fake.gateway);
    const follow = container.querySelector<HTMLButtonElement>('[data-testid="follow-log"]');
    expect(follow?.disabled).toBe(false);
  });

  test("foreign spec: the log button is disabled and says whose box has the logs", async () => {
    const fake = makeGateway("in_progress", "sumesh");
    await mount(fake.gateway);
    const follow = container.querySelector<HTMLButtonElement>('[data-testid="follow-log"]');
    expect(follow?.disabled).toBe(true);
    expect(follow?.title).toContain("sumesh");
  });
});

describe("SpecDetail assignee editing", () => {
  const buttonByText = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const assigneeTrigger = () =>
    container.querySelector<HTMLButtonElement>(".prop-assignee .select-trigger");

  const startEditing = async () => {
    act(() => buttonByText("Edit").click());
    await settle();
  };

  test("the assignee edits as a select of FDE handles and saves the pick", async () => {
    const fake = makeGateway("pending", "uday");
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()?.textContent).toContain("uday");
    act(() => assigneeTrigger()!.click());
    await settle();
    expect(document.querySelector('[data-testid="option-uday"]')).not.toBeNull();

    act(() =>
      document.querySelector<HTMLButtonElement>('[data-testid="option-sumesh"]')!.click(),
    );
    await settle();
    act(() => buttonByText("Save").click());
    await settle();
    expect(fake.updates).toEqual([{ assignee: "sumesh" }]);
  });

  test("an assignee outside the roster stays visible and selectable", async () => {
    const fake = makeGateway("pending", "ghost");
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()?.textContent).toContain("ghost");
    act(() => assigneeTrigger()!.click());
    await settle();
    expect(document.querySelector('[data-testid="option-ghost"]')).not.toBeNull();
  });

  test("a spec can be unassigned via the roster select", async () => {
    const fake = makeGateway("pending", "uday");
    await mount(fake.gateway);
    await startEditing();

    act(() => assigneeTrigger()!.click());
    await settle();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="option-"]')!.click());
    await settle();
    act(() => buttonByText("Save").click());
    await settle();
    expect(fake.updates).toEqual([{ assignee: "" }]);
  });

  test("no roster endpoint: assignee falls back to the free-form input", async () => {
    const fake = makeGateway("pending", "uday", { noFdeRoster: true });
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()).toBeNull();
    const input = container.querySelector<HTMLInputElement>(".prop-assignee input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("uday");
  });
});

describe("SpecDetail stop action", () => {
  const buildRun = (partial: Partial<RunView> & Pick<RunView, "id">): RunView => ({
    project: "chorus",
    spec_id: "s1",
    node: "this-box",
    role: "build",
    agent: "claude-code",
    status: "running",
    started_at: "2026-07-15T10:00:00Z",
    ...partial,
  });
  const stopButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="detail-stop"]');
  const confirmButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="confirm-stop"]');

  test("only an in_progress spec offers Stop", async () => {
    for (const status of ["pending", "review", "done", "cancelled"] as const) {
      const fake = makeGateway(status);
      await mount(fake.gateway);
      expect(stopButton()).toBeNull();
      act(() => root.unmount());
      container.remove();
    }
    const fake = makeGateway("in_progress", "uday");
    await mount(fake.gateway);
    expect(stopButton()).not.toBeNull();
  });

  test("confirm stops the resolved running build run and refreshes the detail", async () => {
    const fake = makeGateway("in_progress", "uday");
    fake.setRuns([
      buildRun({ id: "run-old", started_at: "2026-07-14T10:00:00Z" }),
      buildRun({ id: "run-b1" }),
      buildRun({ id: "run-review", role: "review", started_at: "2026-07-16T10:00:00Z" }),
    ]);
    await mount(fake.gateway);

    act(() => stopButton()!.click());
    await settle();
    expect(text()).toContain("Stop s1?");
    expect(text()).toContain("run-b1");
    expect(fake.stopCalls).toEqual([]);

    const loadsBefore = fake.getSpecCalls.count;
    act(() => confirmButton()!.click());
    await settle();

    expect(fake.stopCalls).toEqual(["run-b1"]);
    expect(text()).toContain("Stopped — spec cancelled.");
    expect(fake.getSpecCalls.count).toBeGreaterThan(loadsBefore);
  });

  test("cancelling the dialog stops nothing", async () => {
    const fake = makeGateway("in_progress", "uday");
    fake.setRuns([buildRun({ id: "run-b1" })]);
    await mount(fake.gateway);

    act(() => stopButton()!.click());
    await settle();
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    act(() => cancel.click());
    await settle();
    expect(fake.stopCalls).toEqual([]);
  });

  test("no running run on this server: an honest toast, no blind stop", async () => {
    const fake = makeGateway("in_progress", "uday");
    fake.setRuns([buildRun({ id: "run-b1", status: "completed" })]);
    await mount(fake.gateway);

    act(() => stopButton()!.click());
    await settle();
    expect(fake.stopCalls).toEqual([]);
    expect(container.querySelector('[data-testid="confirm-stop"]')).toBeNull();
    expect(text()).toContain("No running build run for s1");
    expect(text()).toContain("another FDE");
  });

  test("a refusal surfaces its mapped toast instead of a raw error", async () => {
    const fake = makeGateway("in_progress", "uday");
    fake.setRuns([buildRun({ id: "run-b1", node: "ravi-box" })]);
    fake.setStopResult({
      ok: false,
      error: { status: 409, code: "run_on_other_node", message: "run on other node" },
    });
    await mount(fake.gateway);

    act(() => stopButton()!.click());
    await settle();
    act(() => confirmButton()!.click());
    await settle();
    expect(text()).toContain("ravi-box");
    expect(text()).toContain("stop it from that box");
  });

  test("a cancelled spec renders its badge and offers Re-dispatch", async () => {
    const fake = makeGateway("cancelled");
    await mount(fake.gateway);
    expect(text()).toContain("Cancelled");
    expect(container.querySelector('[data-testid="detail-dispatch"]')?.textContent).toBe(
      "Re-dispatch",
    );
  });

  test("an unknown status string from a newer sail still renders", async () => {
    const fake = makeGateway("paused" as GlobalSpecView["status"]);
    await mount(fake.gateway);
    expect(text()).toContain("paused");
    expect(stopButton()).toBeNull();
  });
});

describe("SpecDetail room findings", () => {
  test("a review card expands its findings inline", async () => {
    const fake = makeGateway("review");
    await mount(fake.gateway);

    const row = container.querySelector<HTMLButtonElement>('[data-testid="review-row-rev-1"]');
    expect(row?.textContent).toContain("1 findings");
    act(() => row!.click());
    await settle();

    expect(text()).toContain("Off-by-one in retry cap");
    expect(text()).toContain("src/x.ts:3");
    expect(text()).toContain("The loop retries one time fewer than configured.");
  });
});
