import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Cross } from "./icons";

export type DialogSize = "sm" | "md" | "lg" | "xl" | "full";

export type DialogProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Return false (sync or async) to veto the close — e.g. unsaved changes. */
  onBeforeClose?: () => boolean | Promise<boolean>;
  children: ReactNode;
  title?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
};

/**
 * Dialog ported from light-grid-wapp's Modal: centered panel on wide
 * viewports, bottom sheet on narrow ones (<=640px), escape/outside-click
 * close through the async onBeforeClose gate, body scroll lock, and a
 * double-rAF entrance so the first frame renders in the closed position.
 */
export function Dialog({
  isOpen,
  onClose,
  onBeforeClose,
  children,
  title,
  headerActions,
  footer,
  size = "md",
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  const handleClose = useCallback(async () => {
    if (onBeforeClose && !(await onBeforeClose())) return;
    onClose();
  }, [onClose, onBeforeClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setIsAnimating(true));
      });
    } else {
      document.body.style.overflow = "";
      setIsAnimating(false);
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") void handleClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        void handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside, true);
    return () => document.removeEventListener("mousedown", handleClickOutside, true);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  return (
    <div className="dialog-layer">
      <div className={cx("dialog-backdrop", isAnimating && "is-open")} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={cx("dialog-panel", `dialog-${size}`, isAnimating && "is-open")}
      >
        {title && (
          <div className="dialog-header">
            <h2 className="dialog-title">{title}</h2>
            <div className="dialog-header-actions">
              {headerActions}
              <button type="button" className="dialog-close" onClick={() => void handleClose()} aria-label="Close">
                <Cross size={14} />
              </button>
            </div>
          </div>
        )}
        <div className="dialog-content">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
