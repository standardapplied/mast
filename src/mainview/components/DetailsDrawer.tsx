import { useEffect, useRef, type ReactNode } from "react";
import { Cross } from "./icons";
import { Splitter } from "./Splitter";

export function DetailsDrawer({
  width,
  onWidth,
  onWidthCommit,
  onClose,
  children,
}: {
  width: number;
  onWidth: (width: number) => void;
  onWidthCommit?: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const drawer = useRef<HTMLElement>(null);

  useEffect(() => {
    drawer.current?.style.setProperty("--room-drawer-width", `${width}px`);
  }, [width]);

  return (
    <>
      <button
        type="button"
        className="room-drawer-backdrop"
        aria-label="Close details"
        onClick={onClose}
      />
      <Splitter
        value={width}
        min={320}
        max={640}
        controls="after"
        onChange={onWidth}
        onDragEnd={onWidthCommit}
        ariaLabel="Resize details drawer"
      />
      <aside
        ref={drawer}
        id="room-details-drawer"
        className="room-details-drawer"
        aria-label="Spec details"
      >
        <div className="room-drawer-head">
          <button
            type="button"
            className="room-drawer-close"
            onClick={onClose}
            aria-label="Close details"
          >
            <Cross size={16} />
          </button>
        </div>
        <div className="room-drawer-scroll">{children}</div>
      </aside>
    </>
  );
}
