import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { CaretRight } from "./icons";

/**
 * Right-click context menu, theme-aware and viewport-clamped. Opened at a
 * screen point (cursor) rather than anchored to an element. Recursive submenu
 * support: an item with `submenu` opens a nested panel to its right on hover.
 * Outside-click (mousedown) and Escape close it — the same close discipline as
 * Select/DropdownPanel, which WebKit honors during native events.
 */

export type MenuNode =
  | {
      kind: "item";
      label: ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
      hint?: string;
      danger?: boolean;
      submenu?: MenuNode[];
    }
  | { kind: "separator" };

function MenuPanel({ items, onClose }: { items: MenuNode[]; onClose: () => void }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className="context-menu" role="menu">
      {items.map((item, index) =>
        item.kind === "separator" ? (
          <div key={index} className="context-menu-sep" role="separator" />
        ) : (
          <div
            key={index}
            className="context-menu-row"
            onMouseEnter={() => setOpenIndex(item.submenu ? index : null)}
          >
            <button
              type="button"
              role="menuitem"
              className={cx("context-menu-item", item.danger && "is-danger")}
              disabled={item.disabled}
              onClick={() => {
                if (item.submenu) return;
                item.onSelect?.();
                onClose();
              }}
            >
              <span className="context-menu-label">{item.label}</span>
              {item.hint && <span className="context-menu-hint">{item.hint}</span>}
              {item.submenu && <CaretRight size={12} className="context-menu-caret" />}
            </button>
            {item.submenu && openIndex === index && (
              <div className="context-submenu">
                <MenuPanel items={item.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuNode[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - width - 8);
    const top = Math.min(y, window.innerHeight - height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase: Tauri's injected drag-region handler stopImmediatePropagation()s document
    // bubble-phase mousedowns on the chrome band, which would let a window drag start with this
    // menu still open. Capture listeners run before it. (Same discipline in every outside-closer.)
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu-layer" style={{ left: pos.left, top: pos.top }} data-testid="context-menu">
      <MenuPanel items={items} onClose={onClose} />
    </div>
  );
}
