import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FakeTimers, layOutElements } from "../../../test/terminalFakes";
import {
  MIN_THUMB_PX,
  rowForThumbTop,
  SCROLLBAR_IDLE_MS,
  TerminalScrollbar,
  thumbFor,
} from "./TerminalScrollbar";
import type { Scrollbar } from "./vtCore";

/** 1000 lines of history under a 24-row screen — the shape the controller test pins. */
const DEEP: Scrollbar = { total: 1001, offset: 0, len: 24 };
const BOTTOM: Scrollbar = { total: 1001, offset: 977, len: 24 };
/** The track under {@link layOutElements}: every element is 496 px tall. */
const TRACK = 496;

describe("thumb geometry", () => {
  test("the thumb is the visible fraction of the track, no smaller than the grab minimum", () => {
    expect(thumbFor({ total: 100, offset: 0, len: 50 }, 400)).toEqual({ top: 0, height: 200 });
    expect(thumbFor(DEEP, TRACK)!.height).toBe(MIN_THUMB_PX);
  });

  test("the thumb's travel maps the offset onto the track, ending flush at the bottom", () => {
    expect(thumbFor(BOTTOM, TRACK)).toEqual({ top: TRACK - MIN_THUMB_PX, height: MIN_THUMB_PX });
    expect(thumbFor({ total: 100, offset: 25, len: 50 }, 400)).toEqual({ top: 100, height: 200 });
  });

  test("nothing to scroll: a fresh terminal or the alternate screen has no thumb", () => {
    expect(thumbFor({ total: 24, offset: 0, len: 24 }, TRACK)).toBeNull();
    expect(thumbFor(DEEP, 0)).toBeNull();
  });

  test("a thumb top maps back to the row that puts it there, clamped to the range", () => {
    const { top } = thumbFor({ ...DEEP, offset: 300 }, TRACK)!;
    expect(rowForThumbTop(DEEP, TRACK, top)).toBe(300);
    expect(rowForThumbTop(DEEP, TRACK, -50)).toBe(0);
    expect(rowForThumbTop(DEEP, TRACK, 10_000)).toBe(977);
  });
});

describe("TerminalScrollbar", () => {
  let host: HTMLDivElement;
  let root: Root;
  let timers: FakeTimers;
  let rows: number[];
  let restoreLayout: () => void;

  beforeEach(() => {
    restoreLayout = layOutElements();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    timers = new FakeTimers();
    rows = [];
    leaked = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    restoreLayout();
  });

  let leaked = 0;
  /** Inside a host with the pane's kind of React pointer handlers, which a bar gesture must not reach. */
  const render = (bar: Scrollbar) =>
    act(() =>
      root.render(
        <div onPointerDown={() => leaked++} onPointerMove={() => leaked++} onPointerUp={() => leaked++}>
          <TerminalScrollbar bar={bar} timers={timers} onScrollTo={(row) => rows.push(row)} />
        </div>,
      ),
    );
  const track = () => host.querySelector<HTMLElement>('[data-testid="term-scrollbar"]');
  const thumb = () => host.querySelector<HTMLElement>('[data-testid="term-scrollbar-thumb"]')!;
  const pointer = (target: Element, type: string, clientY: number) => {
    const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    act(() => {
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: 5, clientY, button: 0 }));
    });
  };

  test("draws the thumb where the core says the viewport is", () => {
    render({ ...DEEP, offset: 300 });
    const { top, height } = thumbFor({ ...DEEP, offset: 300 }, TRACK)!;
    expect(thumb().style.top).toBe(`${top}px`);
    expect(thumb().style.height).toBe(`${height}px`);
    expect(track()!.getAttribute("aria-valuenow")).toBe("300");
    expect(track()!.getAttribute("aria-valuemax")).toBe("977");
  });

  test("the alternate screen shows no bar", () => {
    render({ total: 24, offset: 0, len: 24 });
    expect(track()).toBeNull();
  });

  test("dragging the thumb asks for the row under it, and never leaks the pointer to the pane", () => {
    render(DEEP);
    pointer(thumb(), "pointerdown", 10);
    pointer(thumb(), "pointermove", 10 + 118);
    pointer(thumb(), "pointermove", 10 + TRACK);
    pointer(thumb(), "pointerup", 10 + TRACK);
    expect(rows).toEqual([244, 977]);
    expect(leaked, "the pane's own pointer handlers never see a thumb drag").toBe(0);
  });

  test("a click in the track pages towards the click", () => {
    render({ ...DEEP, offset: 500 });
    const { top } = thumbFor({ ...DEEP, offset: 500 }, TRACK)!;
    pointer(track()!, "pointerdown", top - 40);
    pointer(track()!, "pointerdown", top + 60);
    expect(rows).toEqual([476, 524]);
    render(DEEP);
    pointer(track()!, "pointerdown", TRACK - 1);
    expect(rows.at(-1)).toBe(24);
    expect(leaked, "a track click is the bar's, not the pane's").toBe(0);
  });

  test("rests at the bottom: fades after the idle delay, wakes on any move, stays while in history", () => {
    render(BOTTOM);
    expect(track()!.classList.contains("is-idle")).toBe(false);
    act(() => timers.advance(SCROLLBAR_IDLE_MS));
    expect(track()!.classList.contains("is-idle")).toBe(true);
    render({ ...BOTTOM, offset: 900 });
    expect(track()!.classList.contains("is-idle")).toBe(false);
    act(() => timers.advance(SCROLLBAR_IDLE_MS * 10));
    expect(track()!.classList.contains("is-idle"), "scrolled into history the bar never hides").toBe(false);
    render({ ...BOTTOM, total: 1002, offset: 978 });
    act(() => timers.advance(SCROLLBAR_IDLE_MS - 1));
    expect(track()!.classList.contains("is-idle")).toBe(false);
    act(() => timers.advance(1));
    expect(track()!.classList.contains("is-idle")).toBe(true);
  });
});
