import { useEffect, useRef, useState } from "react";
import type { Timers } from "./terminalController";
import type { Scrollbar } from "./vtCore";

/**
 * Where the viewport sits in scrollback, as a macOS-style overlay bar on the pane's right edge.
 * Geometry comes from the core's {@link Scrollbar} — the thumb is the visible fraction, its place
 * the offset — and every gesture (a thumb drag, a click in the track that pages) becomes one
 * absolute row the caller scrolls to, so the bar never owns a position the core disagrees with.
 * Transport-free and timer-injected, so it renders and settles under `bun test`.
 */

/** The thumb never shrinks below this, or a deep transcript's thumb becomes ungrabbable. */
export const MIN_THUMB_PX = 24;
/** How long the bar lingers at the bottom after the viewport last moved. */
export const SCROLLBAR_IDLE_MS = 800;

export interface ThumbGeometry {
  readonly top: number;
  readonly height: number;
}

/** The thumb for {@code bar} in a track {@code trackPx} tall; null when there is nothing to scroll. */
export function thumbFor(bar: Scrollbar, trackPx: number): ThumbGeometry | null {
  if (bar.total <= bar.len || trackPx <= 0) return null;
  const height = Math.round(Math.min(trackPx, Math.max(MIN_THUMB_PX, (trackPx * bar.len) / bar.total)));
  const top = Math.round(((trackPx - height) * bar.offset) / (bar.total - bar.len));
  return { top, height };
}

/** The row a thumb whose top edge sits at {@code top} px asks for — the inverse of {@link thumbFor}. */
export function rowForThumbTop(bar: Scrollbar, trackPx: number, top: number): number {
  const thumb = thumbFor(bar, trackPx);
  const maxRow = bar.total - bar.len;
  if (!thumb || maxRow <= 0) return 0;
  const travel = trackPx - thumb.height;
  if (travel <= 0) return 0;
  return clampRow(Math.round((top / travel) * maxRow), maxRow);
}

export function atBottom(bar: Scrollbar): boolean {
  return bar.offset + bar.len >= bar.total;
}

const clampRow = (row: number, maxRow: number) => Math.min(maxRow, Math.max(0, row));

export interface TerminalScrollbarProps {
  readonly bar: Scrollbar;
  /** Scroll the viewport so this row is its first visible row. */
  readonly onScrollTo: (row: number) => void;
  readonly timers: Timers;
}

export function TerminalScrollbar({ bar, onScrollTo, timers }: TerminalScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackPx, setTrackPx] = useState(0);
  const [idle, setIdle] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; grabY: number; startTop: number } | null>(null);
  const scrollable = bar.total > bar.len;

  // The track exists only while there is history to scroll, so it is (re)measured as it appears.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackPx(track.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [scrollable]);

  // The bar shows whenever the viewport moves and fades once it rests at the bottom; scrolled
  // into history it stays, so the user always knows where they are.
  useEffect(() => {
    setIdle(false);
    if (!atBottom(bar)) return;
    const handle = timers.set(() => setIdle(true), SCROLLBAR_IDLE_MS);
    return () => timers.clear(handle);
  }, [bar, timers]);

  if (!scrollable) return null;
  // The track mounts before it is measured; the thumb follows on the measuring re-render.
  const thumb = thumbFor(bar, trackPx);

  const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !thumb) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = { pointerId: e.pointerId, grabY: e.clientY, startTop: thumb.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onThumbMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    onScrollTo(rowForThumbTop(bar, trackPx, d.startTop + (e.clientY - d.grabY)));
  };
  const onThumbUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    e.stopPropagation();
    drag.current = null;
    setDragging(false);
  };
  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget || !thumb) return;
    e.stopPropagation();
    e.preventDefault();
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const page = y < thumb.top ? -bar.len : bar.len;
    onScrollTo(clampRow(bar.offset + page, bar.total - bar.len));
  };

  const className = ["term-scrollbar", idle && !dragging && "is-idle", dragging && "is-dragging"]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={trackRef}
      className={className}
      data-testid="term-scrollbar"
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={bar.total - bar.len}
      aria-valuenow={bar.offset}
      onPointerDown={onTrackDown}
    >
      {thumb && (
        <div
          className="term-scrollbar__thumb"
          data-testid="term-scrollbar-thumb"
          style={{ top: `${thumb.top}px`, height: `${thumb.height}px` }}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
          onPointerCancel={onThumbUp}
        />
      )}
    </div>
  );
}
