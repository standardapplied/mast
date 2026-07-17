import { useRef } from "react";

/**
 * A draggable divider between two panes: pointer-drag resizes the pane it
 * `controls` (document order — "after" = the pane to its right), clamped to
 * [min, max]. One splitter serves every workbench boundary; the parent owns
 * the width state and persistence.
 */
export function Splitter({
  value,
  min,
  max,
  controls = "after",
  onChange,
  onDragEnd,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  controls?: "before" | "after";
  onChange: (width: number) => void;
  onDragEnd?: (width: number) => void;
  ariaLabel?: string;
}) {
  const latest = useRef(value);
  latest.current = value;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startValue = latest.current;
    const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
    const widthAt = (x: number) =>
      clamp(startValue + (controls === "after" ? startX - x : x - startX));
    const onMove = (ev: PointerEvent) => onChange(widthAt(ev.clientX));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onDragEnd?.(widthAt(ev.clientX));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={startDrag}
    />
  );
}
