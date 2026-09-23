import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  GlobalSpecView,
  PruneReport,
  PruneRequest,
  RunView,
  SailEvent,
  StopRunResponse,
} from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import { ToastProvider } from "../components/Toast";
import type { Gateway } from "../gateway";
import { catalogLaneStubs } from "../../../test/catalogStubs";
import { sessionStore } from "../terminal/sessionStore";
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

const rosterLoaded: Gateway["listFdes"] = async () => ({
  ok: true,
  value: {
    fdes: [
      { handle: "sumesh", display_name: "Sumesh P", role: "member" },
      { handle: "uday", display_name: "Uday K", role: "admin" },
    ],
  },
});

function makeGateway(
  status: GlobalSpecView["status"] = "pending",
  assignee?: string,
  opts: { listFdes?: Gateway["listFdes"]; capabilities?: string[] } = {},
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
  const pruneCalls: PruneRequest[] = [];
  let pruneResult:
    | ((request: PruneRequest) => SailResult<PruneReport> | Promise<SailResult<PruneReport>>)
    | null = null;

  const gateway = {
    ...catalogLaneStubs(),
    whoami: async () => ({
      ok: true as const,
      value: {
        name: "uday",
        fde: "uday",
        role: "admin" as const,
        capabilities: opts.capabilities ?? ["read", "write", "admin"],
      },
    }),
    listFdes: opts.listFdes ?? rosterLoaded,
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
    pruneSpecs: async (request: PruneRequest) => {
      pruneCalls.push(request);
      return pruneResult
        ? pruneResult(request)
        : { ok: true as const, value: pruneReport(request.dry_run) };
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
    listSessions: async () => ({ ok: true as const, value: { hostBootId: "boot-1", sessions: [] } }),
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
    pruneCalls,
    setPruneResult: (
      result: (request: PruneRequest) => SailResult<PruneReport> | Promise<SailResult<PruneReport>>,
    ) => (pruneResult = result),
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

function pruneReport(dryRun: boolean, requested = false): PruneReport {
  return {
    dry_run: dryRun,
    requested,
    specs: 1,
    rooms: 1,
    messages: 4,
    runs: 2,
    reviews: 1,
    files: 0,
    projects: 0,
    events: 3,
    blob_bytes: 2048,
    entries: [{ type: "spec", id: "s1" }],
  };
}

const terminalRequests: unknown[] = [];

async function mount(gateway: Gateway, onBack: () => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  terminalRequests.length = 0;
  sessionStore.connect(gateway, "test-box");
  act(() =>
    root.render(
      <ToastProvider>
        <SpecDetail
          gateway={gateway}
          specId="s1"
          onOpenSpec={() => {}}
          onBack={onBack}
          onOpenTerminal={(request) => terminalRequests.push(request)}
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

const openActions = async () => {
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="detail-actions"]')?.click());
  await settle();
};
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find((b) =>
    (b.textContent ?? "").startsWith(label),
  );

beforeEach(() => {
  localStorage.removeItem("mast.room.details.rooms.open");
  localStorage.removeItem("mast.room.details.board.open");
  localStorage.removeItem("mast.room.details.width");
  sessionStore.reset();
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
      container.querySelector(".room-header-id")?.textContent,
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

    await openActions();
    const action = menuItem("Re-dispatch");
    expect(action, "the review spec's Actions menu offers Re-dispatch").not.toBeUndefined();

    act(() => action?.click());
    await settle();
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Re-dispatch s1");
    expect(text()).toContain("Re-dispatch resets s1 to pending and relaunches on its prior branch.");
    expect(text()).not.toContain("Only pending specs can be dispatched");
  });

  test("the Actions menu maps one verb per primitive — no Run a task", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    await openActions();

    for (const verb of ["Dispatch", "Add an agent", "Open terminal", "Edit"]) {
      expect(menuItem(verb), `${verb} is a room verb`).not.toBeUndefined();
    }
    for (const retired of ["Run a task", "Add member", "Add agent", "New task"]) {
      expect(menuItem(retired), `${retired} is retired`).toBeUndefined();
    }
  });

  test("a pending spec keeps the plain Dispatch action", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    await openActions();
    expect(menuItem("Dispatch")?.textContent).toContain("Dispatch");
    expect(menuItem("Re-dispatch"), "a pending spec dispatches, not re-dispatches").toBeUndefined();
  });

  test("a member's write credential dispatches from the detail — no local admin gate", async () => {
    const fake = makeGateway("pending", undefined, { capabilities: ["read", "write"] });
    await mount(fake.gateway);

    await openActions();
    act(() => menuItem("Dispatch")?.click());
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
  const rosterRetry = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".prop-assignee button")].find(
      (b) => b.textContent === "Retry",
    );

  const startEditing = async () => {
    await openActions();
    act(() => menuItem("Edit")?.click());
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

  test("the assignee is read-only until the roster lands, then offers the roster", async () => {
    const roster = deferred<Awaited<ReturnType<Gateway["listFdes"]>>>();
    const fake = makeGateway("pending", "uday", { listFdes: () => roster.promise });
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()?.disabled).toBe(true);
    expect(assigneeTrigger()?.textContent).toContain("uday");
    expect(container.querySelector(".prop-assignee input")).toBeNull();

    await act(async () => roster.resolve(await rosterLoaded()));
    await settle();
    expect(assigneeTrigger()?.disabled).toBe(false);
    act(() => assigneeTrigger()!.click());
    await settle();
    expect(document.querySelector('[data-testid="option-sumesh"]')).not.toBeNull();
  });

  test("a roster failure shows the error, keeps the field read-only, and retries", async () => {
    let attempts = 0;
    const fake = makeGateway("pending", "uday", {
      listFdes: async () =>
        ++attempts === 1
          ? {
              ok: false,
              error: { status: 502, code: "bad_gateway", message: "upstream down" },
            }
          : rosterLoaded(),
    });
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()?.disabled).toBe(true);
    expect(container.querySelector(".prop-assignee input")).toBeNull();
    expect(container.querySelector(".prop-assignee .field-error")?.textContent).toBe(
      "Couldn’t load the FDE roster — upstream down",
    );

    act(() => rosterRetry()!.click());
    await settle();
    expect(attempts).toBe(2);
    expect(container.querySelector(".prop-assignee .field-error")).toBeNull();
    expect(rosterRetry()).toBeUndefined();
    expect(assigneeTrigger()?.disabled).toBe(false);
  });

  test("a roster call that throws, or a body without a roster, is a failure with Retry — never stuck loading", async () => {
    let attempts = 0;
    const fake = makeGateway("pending", "uday", {
      listFdes: async () => {
        attempts++;
        if (attempts === 1) throw new Error("unexpected token < in JSON");
        return { ok: true, value: {} as { fdes: never[] } };
      },
    });
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()?.disabled).toBe(true);
    expect(container.querySelector(".prop-assignee .field-error")?.textContent).toBe(
      "Couldn’t load the FDE roster — unexpected token < in JSON",
    );
    act(() => rosterRetry()!.click());
    await settle();
    expect(attempts).toBe(2);
    expect(container.querySelector(".prop-assignee .field-error")?.textContent).toContain(
      "the roster is malformed",
    );
    expect(rosterRetry()).toBeDefined();
  });

  test("an empty roster is a failure, not a blank select", async () => {
    const fake = makeGateway("pending", "uday", {
      listFdes: async () => ({ ok: true, value: { fdes: [] } }),
    });
    await mount(fake.gateway);
    await startEditing();

    expect(assigneeTrigger()?.disabled).toBe(true);
    expect(container.querySelector(".prop-assignee .field-error")?.textContent).toContain(
      "the roster is empty",
    );
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

  test("a cancelled spec renders its status and offers Re-dispatch", async () => {
    const fake = makeGateway("cancelled");
    await mount(fake.gateway);
    expect(text()).toContain("Cancelled");
    await openActions();
    expect(menuItem("Re-dispatch")?.textContent).toContain("Re-dispatch");
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

describe("SpecDetail terminal entries", () => {
  test("Actions ▸ Open terminal ▸ Claude Code navigates with the launch request", async () => {
    const fake = makeGateway();
    await mount(fake.gateway);
    await openActions();
    const openRow = [...document.querySelectorAll<HTMLElement>(".context-menu-row")].find((row) =>
      row.textContent?.includes("Open terminal"),
    );
    expect(openRow, "the room's Actions menu carries the submenu").not.toBeUndefined();
    await act(async () => {
      openRow?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await settle();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="deck-new-claude"]')?.click();
    });
    expect(terminalRequests).toEqual([
      { roomId: "s1", project: "chorus", title: "s1", launch: "claude" },
    ]);
    expect(
      container.querySelector('[data-testid="deck-strip"]'),
      "no sessions, nothing terminal-shaped in the header",
    ).toBeNull();
  });

  test("live sessions surface as header cards that navigate focused on the session", async () => {
    const fake = makeGateway();
    (fake.gateway as { listSessions: unknown }).listSessions = async () => ({
      ok: true as const,
      value: {
        hostBootId: "boot-1",
        sessions: [
        {
          name: "room-s1",
          instanceId: "inst-room-s1",
          live: true,
          attached: 1,
          writerFde: "uday",
          room: "s1",
          command: ["claude"],
        },
        ],
      },
    });
    await mount(fake.gateway);
    const card = container.querySelector<HTMLButtonElement>('[data-testid="deck-card-room-s1"]');
    expect(card).not.toBeNull();
    await act(async () => card?.click());
    expect(terminalRequests).toEqual([
      { roomId: "s1", project: "chorus", title: "s1", focus: "room-s1" },
    ]);
  });
});

describe("prune", () => {
  const pruneGo = () => container.querySelector<HTMLButtonElement>('[data-testid="prune-go"]');
  const openPrune = async () => {
    await openActions();
    act(() => menuItem("Prune…")!.click());
    await settle();
  };

  test("only an archived spec offers Prune…", async () => {
    await mount(makeGateway("done", "uday").gateway);
    await openActions();
    expect(menuItem("Prune…")).toBeUndefined();
  });

  test("the report comes first, and confirming erases exactly once and leaves the spec", async () => {
    const fake = makeGateway("archived", "uday");
    let backs = 0;
    await mount(fake.gateway, () => backs++);

    await openPrune();

    expect(fake.pruneCalls).toEqual([{ ids: ["s1"], dry_run: true }]);
    expect(text()).toContain("Prune s1?");
    const report = container.querySelector('[data-testid="prune-report"]')!.textContent ?? "";
    expect(report).toContain("Messages4");
    expect(report).toContain("Runs2");
    expect(report).toContain("Content freed2.0 KB");
    expect(text()).toContain("This cannot be undone.");
    expect(container.querySelector('[data-testid="prune-choices"]')).toBeNull();

    act(() => {
      pruneGo()!.click();
      pruneGo()!.click();
    });
    await settle();

    expect(fake.pruneCalls).toEqual([
      { ids: ["s1"], dry_run: true },
      { ids: ["s1"], dry_run: false },
    ]);
    expect(text()).toContain("Pruned s1 everywhere.");
    expect(pruneGo()).toBeNull();
    expect(backs).toBe(1);
  });

  test("while the erase is in flight nothing closes the dialog", async () => {
    const fake = makeGateway("archived", "uday");
    let answer!: (result: SailResult<PruneReport>) => void;
    fake.setPruneResult((request) =>
      request.dry_run
        ? { ok: true, value: pruneReport(true) }
        : new Promise((resolve) => (answer = resolve)),
    );
    await mount(fake.gateway);
    await openPrune();

    act(() => pruneGo()!.click());
    await settle();

    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    expect(cancel.disabled).toBe(true);
    expect(pruneGo()!.textContent).toBe("Pruning…");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(pruneGo()).not.toBeNull();

    await act(async () => answer({ ok: true, value: pruneReport(false) }));
    await settle();
    expect(pruneGo()).toBeNull();
  });

  test("cancelling after the report erases nothing", async () => {
    const fake = makeGateway("archived", "uday");
    await mount(fake.gateway);
    await openPrune();

    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    act(() => cancel.click());
    await settle();

    expect(fake.pruneCalls).toEqual([{ ids: ["s1"], dry_run: true }]);
  });

  test("a refusal is shown verbatim and nothing can be pruned", async () => {
    const fake = makeGateway("archived", "uday");
    fake.setPruneResult(() => ({
      ok: false,
      error: {
        status: 403,
        code: "forbidden_not_assignee",
        message: "Spec 's1' is assigned to 'mady'.",
        action: "Ask mady or an admin.",
      },
    }));
    await mount(fake.gateway);

    await openPrune();

    expect(container.querySelector('[data-testid="prune-refused"]')!.textContent).toBe(
      "Spec 's1' is assigned to 'mady'. — Ask mady or an admin.",
    );
    expect(pruneGo()!.disabled).toBe(true);
    expect(fake.pruneCalls.length).toBe(1);
  });

  test("a node's prune says main erases it on the next sync and keeps the spec open", async () => {
    const fake = makeGateway("archived", "uday");
    fake.setPruneResult((request) => ({
      ok: true,
      value: pruneReport(request.dry_run, !request.dry_run),
    }));
    let backs = 0;
    await mount(fake.gateway, () => backs++);
    await openPrune();

    act(() => pruneGo()!.click());
    await settle();

    expect(text()).toContain("Asked main to prune s1; it goes on this box's next sync.");
    expect(backs).toBe(0);
  });

  test("a refused erase is shown in the dialog, which stays open to retry", async () => {
    const fake = makeGateway("archived", "uday");
    fake.setPruneResult((request) =>
      request.dry_run
        ? { ok: true, value: pruneReport(true) }
        : {
            ok: false,
            error: {
              status: 409,
              code: "spec_not_prunable",
              message: "Spec 's1' is draft.",
              action: "Archive it first.",
            },
          },
    );
    await mount(fake.gateway);
    await openPrune();

    act(() => pruneGo()!.click());
    await settle();

    expect(container.querySelector('[data-testid="prune-failed"]')!.textContent).toBe(
      "Prune refused: Spec 's1' is draft. — Archive it first.",
    );
    expect(pruneGo()!.disabled).toBe(false);
  });

  test("an erase whose answer never came back says its outcome is unknown", async () => {
    const fake = makeGateway("archived", "uday");
    fake.setPruneResult((request) =>
      request.dry_run
        ? { ok: true, value: pruneReport(true) }
        : { ok: false, error: { status: 0, code: "bridge", message: "timed out" } },
    );
    await mount(fake.gateway);
    await openPrune();

    act(() => pruneGo()!.click());
    await settle();

    expect(container.querySelector('[data-testid="prune-failed"]')!.textContent).toBe(
      "The prune's outcome is unknown (timed out); the board rechecks these specs.",
    );
  });
});
