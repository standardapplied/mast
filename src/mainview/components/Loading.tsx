import { Eyebrow } from "./ui";

/**
 * Loading state: the Mast mark drawing itself — the M strokes in ink on a
 * loop while the flare truck line pulses in the primary color.
 */
export function LoadingMark({ label = "Loading…", size = 44 }: { label?: string; size?: number }) {
  return (
    <div className="loading-mark" data-testid="loading" role="status" aria-label={label}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <path
          className="loading-mark-m"
          d="M 80 28 L 14 28 L 50 58 L 14 88 L 80 88"
          pathLength={100}
          fill="none"
          stroke="currentColor"
          strokeWidth="15"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          className="loading-mark-flare"
          x1="32"
          y1="8"
          x2="68"
          y2="8"
          stroke="var(--primary)"
          strokeWidth="7"
          strokeLinecap="round"
        />
      </svg>
      <Eyebrow>{label}</Eyebrow>
    </div>
  );
}
