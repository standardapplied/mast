import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { cx } from "./cx";

/**
 * Viewport-aware floating panel anchored to a trigger: flips above when there
 * is no room below, clamps its height to the available space, and tracks
 * scroll/resize/visualViewport. Ported from light-grid-wapp, restyled flat.
 */
export function DropdownPanel({
  triggerRef,
  isOpen,
  children,
  className,
  maxHeight = 240,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  isOpen: boolean;
  children: ReactNode;
  className?: string;
  maxHeight?: number;
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

      setStyle({
        position: "fixed",
        left: rect.left,
        width: rect.width,
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
  }, [isOpen, triggerRef, maxHeight]);

  if (!isOpen || !style) return null;

  return (
    <div style={style} className={cx("dropdown-panel", className)}>
      {children}
    </div>
  );
}
