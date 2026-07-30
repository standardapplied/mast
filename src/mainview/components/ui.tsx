import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
  /** Square icon-only button: same control height as every text button and select. */
  icon?: boolean;
};

export function Button({ variant = "primary", icon = false, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "btn",
        variant === "primary" ? "btn-primary" : "btn-ghost",
        icon && "btn-icon",
        className,
      )}
      {...rest}
    />
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title && <div className="card-title">{title}</div>}
      {children}
    </div>
  );
}

export type BadgeTone = "neutral" | "accent" | "error" | "warning" | "success" | "info";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cx("badge", tone !== "neutral" && `badge-${tone}`)}>{children}</span>;
}
