import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "square" as const,
    ...rest,
  };
}

export function CaretDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 6l5 5 5-5" />
    </svg>
  );
}

export function CaretLeft(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

export function CaretRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

export function Cross(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function CalendarDot(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="3.5" width="11" height="10" />
      <path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3" />
      <rect x="7.25" y="9.25" width="1.5" height="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StatusDot({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...rest}>
      <rect x="5" y="5" width="6" height="6" />
    </svg>
  );
}

export function Magnifier(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

/** The Mast mark: ink M, flare truck line above. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Mast">
      <path
        d="M 80 28 L 14 28 L 50 58 L 14 88 L 80 88"
        fill="none"
        stroke="currentColor"
        strokeWidth="15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="32" y1="8" x2="68" y2="8" stroke="#e85a30" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}
