import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Tooltip } from "./Tooltip";

/**
 * The one icon button: a bare glyph with a Tooltip carrying its name. Every icon-only control
 * (file-tree header, terminal pane bar, snapshots, collapsed-panel stubs) renders through this,
 * so size, hover surface, disabled state, and tooltip typography stay identical everywhere.
 */
export function IconButton({
  label,
  side = "bottom",
  className,
  children,
  ...rest
}: {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip content={label} side={side}>
      <button type="button" aria-label={label} className={cx("icon-btn", className)} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
}
