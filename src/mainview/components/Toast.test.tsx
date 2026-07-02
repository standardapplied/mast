import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider, useToast, type ToastType } from "./Toast";

let root: Root;
let container: HTMLElement;

function Trigger({ type, message }: { type: ToastType; message: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" data-testid="fire" onClick={() => showToast(type, message)}>
      fire
    </button>
  );
}

/** Captures scheduled auto-dismiss callbacks so tests fire them synchronously. */
function makeScheduler() {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn, ms, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { scheduled, schedule };
}

function render(type: ToastType = "success", message = "Saved.") {
  const scheduler = makeScheduler();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ToastProvider schedule={scheduler.schedule}>
        <Trigger type={type} message={message} />
      </ToastProvider>,
    ),
  );
  return scheduler;
}

const fire = () => {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="fire"]');
  act(() => btn?.click());
};

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Toast", () => {
  test("showToast renders a toast with the right tone", () => {
    render("error", "Agent failed");
    fire();
    const toast = container.querySelector(".toast");
    expect(toast?.classList.contains("toast-error")).toBe(true);
    expect(toast?.textContent).toContain("Agent failed");
  });

  test("auto-dismisses when the scheduled timeout fires", () => {
    const scheduler = render();
    fire();
    expect(container.querySelectorAll(".toast").length).toBe(1);
    expect(scheduler.scheduled[0]?.ms).toBe(4000);

    act(() => scheduler.scheduled[0]?.fn());
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  test("manual dismiss cancels the pending timeout", () => {
    const scheduler = render();
    fire();
    const dismiss = container.querySelector<HTMLButtonElement>(".toast-dismiss");
    act(() => dismiss?.click());
    expect(container.querySelectorAll(".toast").length).toBe(0);
    expect(scheduler.scheduled[0]?.cancelled).toBe(true);
  });

  test("keeps at most four toasts, evicting the oldest", () => {
    const scheduler = render();
    for (let i = 0; i < 5; i++) fire();
    expect(container.querySelectorAll(".toast").length).toBe(4);
    expect(scheduler.scheduled[0]?.cancelled).toBe(true);
  });
});
