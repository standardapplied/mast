import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { counterText, TerminalSearchBar } from "./TerminalSearchBar";
import type { SearchState } from "./vtCore";

const done = (total: number, selected: number | null): SearchState => ({ status: "complete", total, selected });

describe("counterText", () => {
  test("k of n once a match is selected; the count alone while none is", () => {
    expect(counterText("err", done(12, 2))).toBe("3 of 12");
    expect(counterText("err", done(12, null))).toBe("12 matches");
  });

  test("no matches is claimed only once the search is complete", () => {
    expect(counterText("err", done(0, null))).toBe("No matches");
    expect(counterText("err", { status: "running", total: 0, selected: null })).toBe("Searching…");
    expect(counterText("err", { status: "running", total: 4, selected: 0 })).toBe("1 of 4");
  });

  test("nothing to say without a needle or before the controller reports", () => {
    expect(counterText("", done(3, 0))).toBe("");
    expect(counterText("err", null)).toBe("");
  });
});

describe("TerminalSearchBar", () => {
  let host: HTMLDivElement;
  let root: Root;
  let needles: string[];
  let steps: string[];
  let closes: number;
  let leaked: string[];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    needles = [];
    steps = [];
    closes = 0;
    leaked = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** Inside a host with the pane's kind of handlers, none of which a bar event may reach. */
  const render = (needle: string, state: SearchState | null) =>
    act(() =>
      root.render(
        <div
          onKeyDown={(e) => leaked.push(`keydown:${e.key}`)}
          onKeyUp={(e) => leaked.push(`keyup:${e.key}`)}
          onPointerDown={() => leaked.push("pointerdown")}
          onCompositionEnd={() => leaked.push("compositionend")}
        >
          <TerminalSearchBar
            needle={needle}
            state={state}
            onNeedle={(n) => needles.push(n)}
            onStep={(d) => steps.push(d)}
            onClose={() => closes++}
          />
        </div>,
      ),
    );
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="term-search-input"]')!;
  const count = () => host.querySelector('[data-testid="term-search-count"]')!.textContent;
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const key = (type: string, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, key, ...init });
    act(() => {
      input().dispatchEvent(event);
    });
    return event;
  };

  test("opens focused; typing sets the needle and never reaches the shell", () => {
    render("", null);
    expect(document.activeElement).toBe(input());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "err");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(needles).toEqual(["err"]);
    key("keydown", "e");
    key("keyup", "e");
    act(() => {
      input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "é" }));
    });
    expect(leaked).toEqual([]);
  });

  test("Enter steps to the next match, Shift+Enter to the previous, Escape closes", () => {
    render("err", done(3, 0));
    expect(key("keydown", "Enter").defaultPrevented).toBe(true);
    key("keydown", "Enter", { shiftKey: true });
    expect(steps).toEqual(["next", "prev"]);
    key("keydown", "Escape");
    expect(closes).toBe(1);
    expect(leaked).toEqual([]);
  });

  test("Enter and Escape mid-composition belong to the IME: no step, no close, default kept", () => {
    render("err", done(3, 0));
    expect(key("keydown", "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(key("keydown", "Escape", { isComposing: true }).defaultPrevented).toBe(false);
    expect(key("keydown", "Enter", { keyCode: 229 } as KeyboardEventInit).defaultPrevented).toBe(false);
    expect(steps).toEqual([]);
    expect(closes).toBe(0);
    key("keydown", "Enter");
    expect(steps, "once the composition is over, Enter steps again").toEqual(["next"]);
  });

  test("⌘F in the bar selects the needle for retyping instead of opening the browser's find", () => {
    render("error", done(3, 0));
    input().setSelectionRange(0, 0);
    const event = key("keydown", "f", { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 5]);
    expect(leaked).toEqual([]);
  });

  test("the counter and the arrows follow the search state", () => {
    render("err", done(12, 2));
    expect(count()).toBe("3 of 12");
    expect(button("Next match").disabled).toBe(false);
    act(() => button("Next match").click());
    act(() => button("Previous match").click());
    expect(steps).toEqual(["next", "prev"]);
    render("zzz", done(0, null));
    expect(count()).toBe("No matches");
    expect(button("Next match").disabled).toBe(true);
    expect(button("Previous match").disabled).toBe(true);
    act(() => button("Close find").click());
    expect(closes).toBe(1);
  });

  test("a click in the bar never starts a selection in the pane", () => {
    render("err", done(1, 0));
    const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    act(() => {
      input().dispatchEvent(new Ctor("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(leaked).toEqual([]);
  });
});
