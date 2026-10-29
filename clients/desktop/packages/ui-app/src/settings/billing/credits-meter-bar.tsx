import { type JSX } from 'react';

export interface CreditsMeterBarProps {
  /** Fill percentage (0–100). Clamped to `[0, 100]`. */
  pct: number;
  /** Extra classes for the outer track (e.g. spacing). */
  className?: string;
  /** Accessible label for the meter (rendered as `aria-label`). */
  ariaLabel?: string;
}

/**
 * Thin horizontal progress meter shared across the AI-credits surfaces: the
 * monthly-allotment "remaining" bar on the wallet card and the auto-top-up
 * month-to-date spend meter. Presentational only — the caller computes the
 * percentage so this stays free of billing semantics.
 */
export function CreditsMeterBar({
  pct,
  className,
  ariaLabel,
}: CreditsMeterBarProps): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={ariaLabel}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-line-base${
        className ? ` ${className}` : ''
      }`}
    >
      <div
        className="h-full rounded-full bg-accent"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
