import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./cx";
import { Cross, StatusDot } from "./icons";

export type ToastType = "success" | "error" | "info";

export type Toast = {
  id: string;
  type: ToastType;
  message: string;
};

type ToastContextValue = {
  toasts: Toast[];
  showToast: (type: ToastType, message: string, duration?: number) => void;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const MAX_TOASTS = 4;
const DEFAULT_SUCCESS_DURATION = 4000;
const DEFAULT_ERROR_DURATION = 6000;

/**
 * `schedule` is injectable so auto-dismiss is testable without waiting; the
 * default is a plain setTimeout.
 */
export function ToastProvider({
  children,
  schedule = (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
}: {
  children: ReactNode;
  schedule?: (fn: () => void, ms: number) => () => void;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const cancels = useRef<Map<string, () => void>>(new Map());

  const dismissToast = useCallback((id: string) => {
    cancels.current.get(id)?.();
    cancels.current.delete(id);
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (type: ToastType, message: string, duration?: number) => {
      const id = crypto.randomUUID();
      const finalDuration =
        duration ?? (type === "success" ? DEFAULT_SUCCESS_DURATION : DEFAULT_ERROR_DURATION);

      setToasts((prev) => {
        const updated = [{ id, type, message }, ...prev];
        while (updated.length > MAX_TOASTS) {
          const removed = updated.pop();
          if (removed) {
            cancels.current.get(removed.id)?.();
            cancels.current.delete(removed.id);
          }
        }
        return updated;
      });

      cancels.current.set(
        id,
        schedule(() => dismissToast(id), finalDuration),
      );
    },
    [dismissToast, schedule],
  );

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={cx("toast", `toast-${toast.type}`)} role="status">
          <StatusDot size={14} className="toast-dot" />
          <p className="toast-message">{toast.message}</p>
          <button type="button" className="toast-dismiss" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <Cross size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
