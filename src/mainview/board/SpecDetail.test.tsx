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

function makeGateway(status: GlobalSpecView["status"] = "pending", assignee?: string) {
  const main = spec({ id: "s1", depends_on: ["dep-a"], status, assignee });
  const dep = spec({ id: "dep-a", status: "done" });
  const listeners = new Set<(e: SailEvent) => void>();
  let enrichGate: Promise<void> = Promise.resolve();
  let revisions = [{ rev: 1, recorded_at: "2026-07-09T00:00:00Z", origin: "create", deleted: false }];

  const gateway = {
    whoami: async () => ({
      ok: true as const,
      value: { name: "uday", fde: "uday", role: "admin" as const, capabilities: ["admin"] },
    }),
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
      return { ok: true as const, value: { spec_id: "s1", reviews: [] } };
    },
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
