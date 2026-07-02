import { cx } from "./cx";

/**
 * On/off switch in the house geometry: hairline track, square knob sliding
 * left/right, ink-filled when on. A control, not a checkbox. `asIndicator`
 * renders the same visual as an inert span for use inside an interactive row
 * (e.g. a multi-select option) that owns the click itself.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  asIndicator = false,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  asIndicator?: boolean;
}) {
  const classes = cx("switch", checked && "is-on", asIndicator && disabled && "is-disabled");

  if (asIndicator) {
    return (
      <span className={classes} aria-hidden="true">
        <span className="switch-knob" />
      </span>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={classes}
      onClick={() => onChange?.(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}
