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
  const gateway = {
    dispatch: async () => ({
      ok: true as const,
      value: { name: "chorus", dispatched: true, reason: "", branch_created: true },
    }),
  } as unknown as Gateway;
  const calls = { closed: 0, results: [] as Array<{ message: string; ok: boolean }> };
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
});
