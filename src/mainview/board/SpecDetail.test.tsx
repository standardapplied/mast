import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GlobalSpecView, SailEvent } from "../../shared/sail-models";
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
  opts: { noFdeRoster?: boolean } = {},
) {
  const main = spec({ id: "s1", depends_on: ["dep-a"], status, assignee });
  const dep = spec({ id: "dep-a", status: "done" });
  const listeners = new Set<(e: SailEvent) => void>();
  const updates: unknown[] = [];
  let enrichGate: Promise<void> = Promise.resolve();
  let revisions = [{ rev: 1, recorded_at: "2026-07-09T00:00:00Z", origin: "create", deleted: false }];

  const gateway = {
    whoami: async () => ({
      ok: true as const,
      value: { name: "uday", fde: "uday", role: "admin" as const, capabilities: ["admin"] },
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
    getSpec: async () => ({ ok: true as const, value: { spec: main }, etag: '"e1"' }),
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

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SpecDetail anti-flicker", () => {
  test("readiness and empty-states wait for enrichment instead of guessing", async () => {
    const fake = makeGateway();
    const gate = deferred<void>();
    fake.setEnrichGate(gate.promise);
    await mount(fake.gateway);

    expect(text()).toContain("s1");
    expect(container.querySelector('[data-testid="blocked-banner"]')).toBeNull();
    expect(text()).not.toContain("No reviews yet.");

    await act(async () => gate.resolve());
    await settle();

    expect(container.querySelector('[data-testid="blocked-banner"]')).toBeNull();
    expect(text()).toContain("No reviews yet.");
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
    expect(text()).toContain("No reviews yet.");

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
    expect(container.querySelector('[data-testid="option-uday"]')).not.toBeNull();

    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="option-sumesh"]')!.click(),
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
    expect(container.querySelector('[data-testid="option-ghost"]')).not.toBeNull();
  });

  test("a spec can be unassigned via the roster select", async () => {
    const fake = makeGateway("pending", "uday");
    await mount(fake.gateway);
    await startEditing();

    act(() => assigneeTrigger()!.click());
    await settle();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="option-"]')!.click());
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

describe("SpecDetail review findings", () => {
  test("a review row opens its findings in a dialog", async () => {
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
