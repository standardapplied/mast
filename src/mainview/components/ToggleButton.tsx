import { cx } from "./cx";

export type ToggleOption = {
  value: string;
  label: string;
};

/**
 * Segmented control with a sliding thumb, ported from light-grid-wapp and
 * restyled squared/flat: hairline track, surface thumb, mono labels.
 */
export function ToggleButton({
  options,
  value,
  onChange,
  className,
}: {
  options: ToggleOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const count = options.length;

  return (
    <div
      className={cx("toggle", className)}
      style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}
      role="radiogroup"
    >
      {selectedIndex >= 0 && (
        <div
          className="toggle-thumb"
          style={{
            left: `calc(${(selectedIndex / count) * 100}% + 2px)`,
            width: `calc(${(1 / count) * 100}% - 4px)`,
          }}
        />
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx("toggle-option", value === option.value && "is-selected")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
