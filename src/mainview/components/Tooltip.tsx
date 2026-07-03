import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./cx";

/**
 * Hover/focus tooltip ported from light-grid-wapp: viewport-aware placement
 * that flips to the opposite side when it won't fit and clamps to the edges,
 * with a small arrow pointing at the trigger. Restyled flat/squared on the
 * SAIL tokens (ink surface, paper text). Only arms on hover-capable devices.
 */

type Side = "top" | "bottom" | "left" | "right";

const GAP = 8;
const EDGE = 8;
const ARROW_CLAMP = 12;

const FLIP: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function resolve(tr: DOMRect, tt: DOMRect, side: Side, vw: number, vh: number) {
  const vert = side === "top" || side === "bottom";
  let t =
    side === "top"
      ? tr.top - tt.height - GAP
      : side === "bottom"
        ? tr.bottom + GAP
        : tr.top + (tr.height - tt.height) / 2;
  let l =
    side === "left"
      ? tr.left - tt.width - GAP
      : side === "right"
        ? tr.right + GAP
        : tr.left + (tr.width - tt.width) / 2;

  const fits = vert
    ? side === "top"
      ? t >= EDGE
      : t + tt.height <= vh - EDGE
    : side === "left"
      ? l >= EDGE
      : l + tt.width <= vw - EDGE;

  l = Math.max(EDGE, Math.min(l, vw - tt.width - EDGE));
  t = Math.max(EDGE, Math.min(t, vh - tt.height - EDGE));
  return { top: t, left: l, fits };
}

export function Tooltip({
  content,
  children,
  side = "top",
  delayMs = 300,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  delayMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  const [arrow, setArrow] = useState(0);
  const [activeSide, setActiveSide] = useState<Side>(side);

  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canHover = useRef(
    typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches,
  );

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;
    const tr = trigger.getBoundingClientRect();
    const tt = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let result = resolve(tr, tt, side, vw, vh);
    let used = side;
    if (!result.fits) {
      const flipped = resolve(tr, tt, FLIP[side], vw, vh);
      if (flipped.fits) {
        result = flipped;
        used = FLIP[side];
      }
    }
    setPos({ top: result.top, left: result.left });
    setActiveSide(used);

    const isVert = used === "top" || used === "bottom";
    const center = isVert
      ? tr.left + tr.width / 2 - result.left
      : tr.top + tr.height / 2 - result.top;
    const max = isVert ? tt.width : tt.height;
    setArrow(Math.max(ARROW_CLAMP, Math.min(center, max - ARROW_CLAMP)));
  }, [side]);

  const show = useCallback(() => {
    if (!canHover.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delayMs);
  }, [delayMs]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!content) return <>{children}</>;

  const isVert = activeSide === "top" || activeSide === "bottom";
  const arrowStyle: React.CSSProperties = {
    ...(isVert ? { left: arrow } : { top: arrow }),
    ...(activeSide === "top" && { bottom: -3 }),
    ...(activeSide === "bottom" && { top: -3 }),
    ...(activeSide === "left" && { right: -3 }),
    ...(activeSide === "right" && { left: -3 }),
  };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="tooltip-trigger"
      >
        {children}
      </span>
      {open && (
        <div ref={tipRef} role="tooltip" className={cx("tooltip", `tooltip-${activeSide}`)} style={pos}>
          {content}
          <span className="tooltip-arrow" style={arrowStyle} />
        </div>
      )}
    </>
  );
}
