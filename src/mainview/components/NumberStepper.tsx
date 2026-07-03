import { useCallback, useRef, useState } from "react";
import { cx } from "./cx";
import { Minus, Plus } from "./icons";

/**
 * Number stepper ported from light-grid-wapp, restyled flat/squared: minus and
 * plus flank a click-to-edit centre. Clamped to [min, max]; the centre accepts
 * digits only and commits on blur/Enter.
 */
export function NumberStepper({
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const canDec = !disabled && value > min;
  const canInc = !disabled && value < max;

  const commit = useCallback(
    (raw: string) => {
      setEditing(false);
      const trimmed = raw.trim();
      if (trimmed === "") {
        onChange(min);
        return;
      }
      const parsed = parseInt(trimmed, 10);
      if (Number.isNaN(parsed)) return;
      onChange(Math.min(max, Math.max(min, parsed)));
    },
    [onChange, min, max],
  );

  const startEdit = useCallback(() => {
    if (disabled) return;
    setEditValue(value.toString());
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [disabled, value]);

  return (
    <div className={cx("stepper", disabled && "is-disabled")}>
      <button
        type="button"
        className="stepper-btn"
        onClick={() => canDec && onChange(Math.max(min, value - step))}
        disabled={!canDec}
        aria-label="Decrease"
      >
        <Minus size={14} />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          className="stepper-value"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => commit(editValue)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(editValue);
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button type="button" className="stepper-value" onClick={startEdit} disabled={disabled}>
          {value}
        </button>
      )}
      <button
        type="button"
        className="stepper-btn"
        onClick={() => canInc && onChange(Math.min(max, value + step))}
        disabled={!canInc}
        aria-label="Increase"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
