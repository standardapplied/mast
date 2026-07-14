import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDemoGateway } from "../gateway";
import { LiveLog } from "./LiveLog";

let root: Root;
let container: HTMLElement;

function mount(onClose: () => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <LiveLog
        gateway={createDemoGateway()}
        project="chorus"
        specId="chorus-invoice-ui"
        onClose={onClose}
      />,
    ),
  );
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const body = () => container.querySelector('[data-testid="live-log-body"]')?.textContent ?? "";
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("LiveLog", () => {
  test("renders the build stream as readable lines and drops the system event", async () => {
    mount();
    await settle();
    expect(body()).toContain("Tests pass");
    expect(body()).toContain("⚙ Bash(bun test)");
    expect(body()).toContain("↳ ok");
    // The noisy system/init event renders to nothing.
    expect(body()).not.toContain('"type":"system"');
  });

  test("toggling to Review follows the review log", async () => {
    mount();
    await settle();
    expect(body()).not.toContain("Reviewing the diff");
    await act(async () => button("Review")?.click());
    await settle();
    expect(body()).toContain("Reviewing the diff");
    expect(body()).toContain("── result ──");
  });

  test("the raw toggle shows the unprocessed stream", async () => {
    mount();
    await settle();
    expect(body()).not.toContain('"type":"assistant"');
    const raw = container.querySelector('button[role="checkbox"]') as HTMLElement;
    await act(async () => raw.click());
    expect(body()).toContain('"type":"assistant"');
  });

  test("the header shows this spec's own run, never the container's other session", async () => {
    mount();
    await settle();
    const status = container.querySelector('[data-testid="live-log-status"]')?.textContent ?? "";
    expect(status).toContain("Running");
    expect(status).toContain("agent/chorus-invoice-ui");
    // The old container-scoped "running a different spec" heuristic is gone —
    // the log and the header are both pinned to the clicked spec's run.
    expect(container.querySelector('[data-testid="live-log-elsewhere"]')).toBeNull();
  });

  test("closing invokes onClose", async () => {
    let closed = false;
    mount(() => {
      closed = true;
    });
    await settle();
    (container.querySelector('button[aria-label="Close agent log"]') as HTMLElement).click();
    expect(closed).toBe(true);
  });
});
