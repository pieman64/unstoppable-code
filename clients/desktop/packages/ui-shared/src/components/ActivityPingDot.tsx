import type { JSX } from 'react';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

export interface ActivityPingDotProps {
  /** Accessible label and native tooltip text for the dot. */
  label: string;
  /** Test ID hook for automation. */
  testId: string;
}

/**
 * Small animated activity dot: a solid dot behind an `animate-ping` ring.
 * Shared by desktop's terminal (running) and browser (loading) panel-tab
 * trailing indicators, and by web's terminal panel-tab running indicator
 * (REG-2987), so the same visual and testid convention holds across both
 * surfaces. Pure display: callers own placement and pass the state-specific
 * `label`/`testId`.
 *
 * The ping ring freezes under `prefers-reduced-motion` (the solid dot alone
 * still conveys the active state); this is additive to the classes desktop
 * originally shipped, not a geometry change.
 *
 * `role="img"` lets `label` name the dot: ARIA 1.2 prohibits naming a plain
 * (generic) span, so assistive technology could otherwise drop it.
 */
export function ActivityPingDot({
  label,
  testId,
}: ActivityPingDotProps): JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative ml-0.5 inline-flex h-2 w-2 shrink-0 items-center justify-center"
      data-testid={testId}
    >
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full motion-reduce:animate-none ${OPERATIONAL_STATUS_COLORS.active.backgroundPing}`}
      />
      <span
        className={`relative inline-flex h-1.5 w-1.5 rounded-full ${OPERATIONAL_STATUS_COLORS.active.background}`}
      />
    </span>
  );
}
