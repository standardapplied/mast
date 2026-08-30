import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Icon set: Iconoir (https://iconoir.com), MIT-licensed, vendored as inline SVG
 * (no runtime dependency). Iconoir draws on a 24×24 grid with round caps/joins;
 * the stroke is nudged a touch heavier than Iconoir's 1.5 so the glyphs keep
 * their presence at the 13–20px sizes this app renders them at. Logo and Spinner
 * are ours, not Iconoir.
 */
function base({ size = 16, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function SplitColumns(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5h16v14H4z" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function Camera(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l2-2.5h6L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9z" />
      <path d="M12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
    </svg>
  );
}

export function ArrowUp(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 20V4m0 0l-6 6m6-6l6 6" />
    </svg>
  );
}

export function Refresh(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21.888 13.5C21.164 18.311 17.013 22 12 22 6.477 22 2 17.523 2 12S6.477 2 12 2c4.1 0 7.625 2.468 9.168 6" />
      <path d="M17 8h4.4a.6.6 0 0 0 .6-.6V3" />
    </svg>
  );
}

export function CaretDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 9L12 15L18 9" />
    </svg>
  );
}

export function CaretLeft(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 6L9 12L15 18" />
    </svg>
  );
}

export function CaretRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 6L15 12L9 18" />
    </svg>
  );
}

export function Folder(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2 11V4.6C2 4.26863 2.26863 4 2.6 4H8.77805C8.92127 4 9.05977 4.05124 9.16852 4.14445L12.3315 6.85555C12.4402 6.94876 12.5787 7 12.722 7H21.4C21.7314 7 22 7.26863 22 7.6V11M2 11V19.4C2 19.7314 2.26863 20 2.6 20H21.4C21.7314 20 22 19.7314 22 19.4V11M2 11H22" />
    </svg>
  );
}

export function Cross(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6.75827 17.2426L12.0009 12M17.2435 6.75736L12.0009 12M12.0009 12L6.75827 6.75736M12.0009 12L17.2435 17.2426" />
    </svg>
  );
}

export function CalendarDot(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 4V2M15 4V6M15 4H10.5M3 10V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V10H3Z" />
      <path d="M3 10V6C3 4.89543 3.89543 4 5 4H7" />
      <path d="M7 2V6" />
      <path d="M21 10V6C21 4.89543 20.1046 4 19 4H18.5" />
      <rect x="11" y="14.5" width="2" height="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StatusDot({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
      <rect x="9" y="9" width="6" height="6" />
    </svg>
  );
}

export function Sun(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18Z" />
      <path d="M22 12L23 12" />
      <path d="M12 2V1" />
      <path d="M12 23V22" />
      <path d="M20 20L19 19" />
      <path d="M20 4L19 5" />
      <path d="M4 20L5 19" />
      <path d="M4 4L5 5" />
      <path d="M1 12L2 12" />
    </svg>
  );
}

export function Moon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 11.5066C3 16.7497 7.25034 21 12.4934 21C16.2209 21 19.4466 18.8518 21 15.7259C12.4934 15.7259 8.27411 11.5066 8.27411 3C5.14821 4.55344 3 7.77915 3 11.5066Z" />
    </svg>
  );
}

export function Person(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 20V19C5 15.134 8.13401 12 12 12C15.866 12 19 15.134 19 19V20" />
      <path d="M12 12C14.2091 12 16 10.2091 16 8C16 5.79086 14.2091 4 12 4C9.79086 4 8 5.79086 8 8C8 10.2091 9.79086 12 12 12Z" />
    </svg>
  );
}

export function Check(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 13L9 17L19 7" />
    </svg>
  );
}

export function Funnel(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.99961 3H19.9997C20.552 3 20.9997 3.44764 20.9997 3.99987L20.9999 5.58569C21 5.85097 20.8946 6.10538 20.707 6.29295L14.2925 12.7071C14.105 12.8946 13.9996 13.149 13.9996 13.4142V19.7192C13.9996 20.3698 13.3882 20.8472 12.7571 20.6894L10.7571 20.1894C10.3119 20.0781 9.99961 19.6781 9.99961 19.2192V13.4142C9.99961 13.149 9.89425 12.8946 9.70672 12.7071L3.2925 6.29289C3.10496 6.10536 2.99961 5.851 2.99961 5.58579V4C2.99961 3.44772 3.44732 3 3.99961 3Z" />
    </svg>
  );
}

export function Minus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 12H18" />
    </svg>
  );
}

export function Plus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 12H12M18 12H12M12 12V6M12 12V18" />
    </svg>
  );
}

export function Send(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M22.1525 3.55321L11.1772 21.0044L9.50686 12.4078L2.00002 7.89795L22.1525 3.55321Z" />
      <path d="M9.45557 12.4436L22.1524 3.55321" />
    </svg>
  );
}

export function PanelRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3V21" />
    </svg>
  );
}

export function Info(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 11.5V16.5" />
      <path d="M12 7.51L12.01 7.49889" />
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
    </svg>
  );
}

export function Magnifier(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M17 17L21 21" />
      <path d="M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z" />
    </svg>
  );
}

export function FolderPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18 6H20M22 6H20M20 6V4M20 6V8" />
      <path d="M21.4 20H2.6C2.26863 20 2 19.7314 2 19.4V11H21.4C21.7314 11 22 11.2686 22 11.6V19.4C22 19.7314 21.7314 20 21.4 20Z" />
      <path d="M2 11V4.6C2 4.26863 2.26863 4 2.6 4H8.77805C8.92127 4 9.05977 4.05124 9.16852 4.14445L12.3315 6.85555C12.4402 6.94876 12.5787 7 12.722 7H14" />
    </svg>
  );
}

export function PagePlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12V2.6C4 2.26863 4.26863 2 4.6 2H16.2515C16.4106 2 16.5632 2.06321 16.6757 2.17574L19.8243 5.32426C19.9368 5.43679 20 5.5894 20 5.74853V21.4C20 21.7314 19.7314 22 19.4 22H11" />
      <path d="M16 2V5.4C16 5.73137 16.2686 6 16.6 6H20" />
      <path d="M1.99219 19H4.99219M7.99219 19H4.99219M4.99219 19V16M4.99219 19V22" />
    </svg>
  );
}

/** The Mast mark: the SAIL sigma in ink, flare truck line above. */
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

export function Rooms(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7.5 22C10.5376 22 13 19.5376 13 16.5C13 13.4624 10.5376 11 7.5 11C4.46243 11 2 13.4624 2 16.5C2 17.5018 2.26783 18.441 2.7358 19.25L2.275 21.725L4.75 21.2642C5.55898 21.7322 6.49821 22 7.5 22Z" />
      <path d="M15.2824 17.8978C16.2587 17.7405 17.1758 17.4065 18 16.9297L21.6 17.6L20.9297 14C21.6104 12.8233 22 11.4571 22 10C22 5.58172 18.4183 2 14 2C9.97262 2 6.64032 4.97598 6.08221 8.84884" />
    </svg>
  );
}

export function Board(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 3.6V20.4C3 20.7314 3.26863 21 3.6 21H20.4C20.7314 21 21 20.7314 21 20.4V3.6C21 3.26863 20.7314 3 20.4 3H3.6C3.26863 3 3 3.26863 3 3.6Z" />
      <path d="M6 6L6 16" />
      <path d="M10 6V9" />
      <path d="M14 6V13" />
      <path d="M18 6V11" />
    </svg>
  );
}

export function Terminal(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M13 17H20" />
      <path d="M5 7L10 12L5 17" />
    </svg>
  );
}
