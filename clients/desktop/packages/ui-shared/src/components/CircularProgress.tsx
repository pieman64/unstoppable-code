import type { JSX } from 'react';

/**
 * The ring's role. The arc takes the role's ink and the full track the same
 * role's subtle surface, so a ring reads as one color at two strengths;
 * `neutral` sits on the muted surface.
 */
export type CircularProgressTone =
  | 'neutral'
  | 'accent'
  | 'warning'
  | 'destructive';

const TONE_STROKES: Record<
  CircularProgressTone,
  { readonly arc: string; readonly track: string }
> = {
  neutral: { arc: 'var(--fg-secondary)', track: 'var(--bg-muted)' },
  accent: { arc: 'var(--fg-accent)', track: 'var(--bg-accent-subtle)' },
  warning: { arc: 'var(--fg-warning)', track: 'var(--bg-warning-subtle)' },
  destructive: {
    arc: 'var(--fg-destructive)',
    track: 'var(--bg-destructive-subtle)',
  },
};

export interface CircularProgressProps {
  /** 0–100 */
  percentage: number;
  tone: CircularProgressTone;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function CircularProgress({
  percentage,
  tone,
  size = 14,
  strokeWidth = 2,
  className = '',
}: CircularProgressProps): JSX.Element {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percentage / 100) * circumference;
  const strokes = TONE_STROKES[tone];

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      data-tone={tone}
    >
      <circle
        data-part="track"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokes.track}
        strokeWidth={strokeWidth}
      />
      <circle
        data-part="arc"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokes.arc}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-[stroke-dashoffset,stroke] duration-300"
      />
    </svg>
  );
}
