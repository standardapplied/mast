import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";

/**
 * Viewport-aware floating panel anchored to a trigger: flips above when there
 * is no room below, clamps height AND horizontal position to the viewport
 * (a right-edge trigger must not push the panel off-screen), and tracks
 * scroll/resize/visualViewport. `align="right"` hangs the panel from the
 * trigger's right edge; `minWidth` lets content demand more room than the
 * trigger's own width. Ported from light-grid-wapp, restyled flat.
 */
export function DropdownPanel({
  triggerRef,
  isOpen,
  children,
  className,
  maxHeight = 240,
  align = "left",
  minWidth = 0,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  isOpen: boolean;
  children: ReactNode;
  className?: string;
  maxHeight?: number;
  align?: "left" | "right";
  minWidth?: number;
}) {
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) {
      setStyle(null);
      return;
    }

    const update = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const vv = window.visualViewport;
      const vpTop = vv?.offsetTop ?? 0;
      const vpBottom = vpTop + (vv?.height ?? window.innerHeight);

      const spaceBelow = vpBottom - rect.bottom;
      const spaceAbove = rect.top - vpTop;
      const goAbove = spaceBelow < maxHeight + 8 && spaceAbove > spaceBelow;

      const available = goAbove ? spaceAbove - 8 : spaceBelow - 8;
      const clampedMax = Math.min(maxHeight, Math.max(available, 60));

      const viewportWidth = window.innerWidth;
      const width = Math.min(Math.max(rect.width, minWidth), viewportWidth - 16);
      let left = align === "right" ? rect.right - width : rect.left;
      left = Math.max(8, Math.min(left, viewportWidth - width - 8));

      setStyle({
        position: "fixed",
        left,
        width,
        maxHeight: clampedMax,
        ...(goAbove
          ? { top: rect.top + vpTop - 4, transform: "translateY(-100%)" }
          : { top: rect.bottom + vpTop + 4 }),
      });
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);

    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, [isOpen, triggerRef, maxHeight, align, minWidth]);

  if (!isOpen || !style) return null;

  // Portal to the body so the fixed-position panel resolves against the viewport, not a
  // transformed ancestor (a Dialog's transform would otherwise become its containing block and
  // displace it — the coords are computed from the trigger's viewport rect).
  return createPortal(
    <div style={style} className={cx("dropdown-panel", className)}>
      {children}
    </div>,
    document.body,
  );
}
