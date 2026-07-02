import {
  useCallback,
  useEffect,
  useState,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
  label?: string;
  error?: string;
  autoGrow?: boolean;
  showCount?: boolean;
};

export function Textarea({
  className,
  label,
  id,
  error,
  value,
  autoGrow = false,
  showCount = false,
  maxLength,
  ref,
  ...props
}: TextareaProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [element, setElement] = useState<HTMLTextAreaElement | null>(null);
  const hasError = !!error;

  const callbackRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      setElement(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  useEffect(() => {
    if (autoGrow && element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
      element.style.overflowY = element.scrollHeight > element.clientHeight ? "auto" : "hidden";
    }
  }, [value, autoGrow, element]);

  const currentLength = typeof value === "string" ? value.length : 0;
  const renderCount = showCount && typeof maxLength === "number";
  const atLimit = renderCount && currentLength >= maxLength;
  const nearLimit = renderCount && !atLimit && currentLength >= Math.floor(maxLength * 0.8);

  const limitMessage = atLimit && !error ? "Max characters reached" : null;
  const leftMessage = error || limitMessage;

  return (
    <div className="field">
      {label && (
        <label
          htmlFor={id}
          className={cx("field-label", hasError && "is-error", !hasError && isFocused && "is-focused")}
        >
          {label}
        </label>
      )}
      <textarea
        id={id}
        className={cx("textarea", autoGrow && "auto-grow", hasError && "is-error", className)}
        ref={callbackRef}
        value={value}
        maxLength={maxLength}
        onFocus={(e) => {
          setIsFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          props.onBlur?.(e);
        }}
        {...props}
      />
      {(leftMessage || renderCount) && (
        <div className="field-footer">
          {leftMessage && <p className="field-error">{leftMessage}</p>}
          {renderCount && (
            <span
              className={cx("field-count", atLimit && "is-error", nearLimit && "is-warning")}
              aria-live="polite"
            >
              {currentLength}/{maxLength}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
