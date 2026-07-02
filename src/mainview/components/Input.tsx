import { useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { cx } from "./cx";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> & {
  ref?: Ref<HTMLInputElement>;
  label?: string;
  error?: string;
  prefix?: ReactNode;
  suffixIcon?: ReactNode;
  onSuffixIconClick?: () => void;
};

export function Input({
  className,
  label,
  id,
  error,
  prefix,
  suffixIcon,
  onSuffixIconClick,
  ...props
}: InputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const hasError = !!error;

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
      <div className="field-control">
        {prefix && <span className="field-prefix">{prefix}</span>}
        <input
          id={id}
          className={cx(
            "input",
            hasError && "is-error",
            !!prefix && "has-prefix",
            !!suffixIcon && "has-suffix",
            className,
          )}
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
        {suffixIcon && (
          <button type="button" className="field-suffix" onClick={onSuffixIconClick}>
            {suffixIcon}
          </button>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
