import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Finding, ReviewView } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import type { Gateway } from "../gateway";
import { ReviewFindings } from "./ReviewFindings";

let root: Root;
let container: HTMLElement;

const review: ReviewView = {
  id: "rev-1",
  spec_id: "s1",
  iteration: 2,
  status: "pending_decision",
  created_at: "2026-07-14T10:00:00Z",
  stages: [],
};

const finding = (partial: Partial<Finding> & Pick<Finding, "id" | "severity">): Finding => ({
  category: "correctness",
  line_start: 0,
  line_end: 0,
  title: partial.id,
  description: "desc",
  confidence: 0.9,
  resolution: "OPEN",
  ...partial,
});

function gatewayWith(result: SailResult<{ review: ReviewView; findings: Finding[] }>): Gateway {
  return { reviewDetail: async () => result } as unknown as Gateway;
}

async function mount(gateway: Gateway, onClose = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(<ReviewFindings gateway={gateway} review={review} onClose={onClose} />),
  );
  await act(async () => {});
  await act(async () => {});
}

const text = () => container.textContent ?? "";

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ReviewFindings", () => {
  test("renders each finding with severity, location, and description", async () => {
    await mount(
      gatewayWith({
        ok: true,
        value: {
          review,
          findings: [
            finding({
              id: "f-1",
              severity: "HIGH",
              title: "Race in token bucket refill",
              file: "src/api/limits.ts",
              line_start: 42,
              line_end: 48,
              description: "Two concurrent refills can double-credit the bucket.",
            }),
            finding({
              id: "f-2",
              severity: "LOW",
              title: "Duplicated window math",
              resolution: "DISMISSED",
            }),
          ],
        },
      }),
    );

    expect(text()).toContain("Review #2");
    expect(text()).toContain("Race in token bucket refill");
    expect(text()).toContain("src/api/limits.ts:42–48");
    expect(text()).toContain("Two concurrent refills can double-credit the bucket.");
    expect(text()).toContain("high");
    expect(text()).toContain("dismissed");
  });

  test("a clean review says so instead of an empty pane", async () => {
    await mount(gatewayWith({ ok: true, value: { review, findings: [] } }));
    expect(text()).toContain("No findings");
  });

  test("a failed fetch surfaces the API error", async () => {
    await mount(
      gatewayWith({
        ok: false,
        error: { status: 404, code: "review_not_found", message: "No review 'rev-1'" },
      }),
    );
    expect(text()).toContain("No review 'rev-1'");
  });

  test("close fires onClose", async () => {
    let closed = false;
    await mount(gatewayWith({ ok: true, value: { review, findings: [] } }), () => (closed = true));
    const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "Close");
    act(() => close!.click());
    expect(closed).toBe(true);
  });
});
