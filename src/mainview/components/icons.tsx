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

export function Sun(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </svg>
  );
}

export function Moon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3 4.5 4.5 0 0 0 13 9.5z" />
    </svg>
  );
}

export function Person(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="5" r="2.75" />
      <path d="M2.75 14c.6-3 2.7-4.5 5.25-4.5s4.65 1.5 5.25 4.5" />
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
