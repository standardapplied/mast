import type { ReactNode } from "react";
import { cx } from "./cx";
import { Check } from "./icons";

/**
 * House checkbox — not the native input: a squared hairline box that fills
 * ink with a paper check when on. `asIndicator` renders the same visual as an
 * inert span for use inside an interactive row (e.g. a multi-select option)
 * that owns the click itself.
 */
export function Checkbox({
  checked,
  onChange,
  disabled = false,
  label,
  asIndicator = false,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  asIndicator?: boolean;
}) {
  const classes = cx("checkbox", checked && "is-checked", asIndicator && disabled && "is-disabled");
  const box = (
    <span className="checkbox-box">
      <Check size={11} />
    </span>
  );

  if (asIndicator) {
    return (
      <span className={classes} aria-hidden="true">
        {box}
        {label && <span className="checkbox-label">{label}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={classes}
      onClick={() => onChange?.(!checked)}
    >
      {box}
      {label && <span className="checkbox-label">{label}</span>}
    </button>
  );
}
