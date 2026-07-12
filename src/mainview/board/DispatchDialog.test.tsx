import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GlobalSpecView } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import { DispatchDialog } from "./DispatchDialog";

let root: Root;
let container: HTMLElement;

const SPEC: GlobalSpecView = {
  id: "s1",
  project: "chorus",
  title: "Spec one",
  status: "pending",
  priority: 0,
  depends_on: ["dep-a"],
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-09T00:00:00Z",
};

const DEP_DONE: GlobalSpecView = { ...SPEC, id: "dep-a", depends_on: [], status: "done" };

function mount(overrides: Partial<Parameters<typeof DispatchDialog>[0]> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const calls = {
    closed: 0,
    results: [] as Array<{ message: string; ok: boolean }>,
    requests: [] as Array<Record<string, unknown>>,
  };
  const gateway = {
    dispatch: async (_project: string, request: Record<string, unknown>) => {
      calls.requests.push(request);
      return {
        ok: true as const,
        value: {
          name: "chorus",
          dispatched: true,
          reason: "",
          branch_created: true,
          restarted: request.restart === true,
        },
      };
    },
  } as unknown as Gateway;
  act(() =>
    root.render(
      <DispatchDialog
        gateway={gateway}
        spec={SPEC}
        allSpecs={[SPEC, DEP_DONE]}
        depsKnown
        canDispatch
        roleKnown
        onClose={() => calls.closed++}
        onResult={(message, ok) => calls.results.push({ message, ok })}
        {...overrides}
      />,
    ),
  );
  return calls;
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const go = () => container.querySelector('[data-testid="dispatch-go"]') as HTMLButtonElement;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DispatchDialog", () => {
  test("unknown dependencies hold a quiet checking state, never a Blocked flash", () => {
    mount({ depsKnown: false });
    expect(container.querySelector('[data-testid="dispatch-checking"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dispatch-blocked"]')).toBeNull();
    expect(go().disabled).toBe(true);
  });

  test("known-met dependencies enable dispatch with no warnings", () => {
    mount();
    expect(container.querySelector('[data-testid="dispatch-checking"]')).toBeNull();
    expect(container.querySelector('[data-testid="dispatch-blocked"]')).toBeNull();
    expect(go().disabled).toBe(false);
  });

  test("a truly unmet dependency blocks", () => {
    mount({ allSpecs: [SPEC, { ...DEP_DONE, status: "in_progress" }] });
    expect(container.querySelector('[data-testid="dispatch-blocked"]')).not.toBeNull();
    expect(go().disabled).toBe(true);
  });

  test("submit stays in Dispatching until the dialog closes — no actionable flash", async () => {
    const calls = mount();
    act(() => go().click());
    await settle();

    expect(calls.results).toEqual([{ message: "Dispatched s1 · branch created.", ok: true }]);
    expect(calls.closed).toBe(1);
    expect(go().textContent).toBe("Dispatching…");
    expect(go().disabled).toBe(true);
  });

  test("a non-pending spec is gated on the plain dispatch path", () => {
    mount({ spec: { ...SPEC, status: "review" } });
    expect(container.textContent).toContain("Only pending specs can be dispatched");
    expect(go().disabled).toBe(true);
  });

  test("restart mode dispatches a review spec with the restart flag", async () => {
    const calls = mount({ spec: { ...SPEC, status: "review" }, restart: true });

    expect(container.textContent).not.toContain("Only pending specs can be dispatched");
    expect(container.querySelector('[data-testid="dispatch-restart-note"]')?.textContent).toBe(
      "Re-dispatch resets s1 to pending and relaunches on its prior branch.",
    );
    expect(go().textContent).toBe("Re-dispatch");
    expect(go().disabled).toBe(false);

    act(() => go().click());
    await settle();

    expect(calls.requests).toEqual([{ spec_id: "s1", mode: "background", restart: true }]);
    expect(calls.results).toEqual([{ message: "Re-dispatched s1 (was review).", ok: true }]);
    expect(calls.closed).toBe(1);
    expect(go().textContent).toBe("Dispatching…");
    expect(go().disabled).toBe(true);
  });

  test("restart mode still blocks on unmet dependencies", () => {
    mount({
      spec: { ...SPEC, status: "done" },
      allSpecs: [SPEC, { ...DEP_DONE, status: "in_progress" }],
      restart: true,
    });
    expect(container.querySelector('[data-testid="dispatch-blocked"]')).not.toBeNull();
    expect(go().disabled).toBe(true);
  });

  test("restart mode holds the quiet checking state while dependencies are unknown", () => {
    mount({ spec: { ...SPEC, status: "review" }, restart: true, depsKnown: false });
    expect(container.querySelector('[data-testid="dispatch-checking"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dispatch-blocked"]')).toBeNull();
    expect(go().disabled).toBe(true);
  });

  test("restart mode still role-gates a non-admin credential", () => {
    mount({ spec: { ...SPEC, status: "review" }, restart: true, canDispatch: false });
    expect(container.querySelector('[data-testid="dispatch-role"]')).not.toBeNull();
    expect(go().disabled).toBe(true);
  });

  test("a structured refusal surfaces the server message and action verbatim", async () => {
    const refusing = {
      dispatch: async () => ({
        ok: false as const,
        error: {
          status: 409,
          code: "SPEC_NOT_READY",
          message: "Agent already running for s1.",
          action: "Wait for the current run to finish.",
        },
      }),
    } as unknown as Gateway;
    const calls = mount({ spec: { ...SPEC, status: "review" }, restart: true, gateway: refusing });

    act(() => go().click());
    await settle();

    expect(calls.results).toEqual([
      {
        message: "Dispatch failed: Agent already running for s1. — Wait for the current run to finish.",
        ok: false,
      },
    ]);
    expect(calls.closed).toBe(1);
  });
});
