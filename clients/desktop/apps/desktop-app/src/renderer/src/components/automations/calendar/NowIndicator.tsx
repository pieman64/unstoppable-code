import { type JSX } from 'react';
import { minutesSinceMidnight } from './calendarDateUtils';

interface NowIndicatorProps {
  now: Date;
  /** Pixel height of one hour row in the time grid. */
  hourPx: number;
}

/**
 * Google-Calendar-style red "now" line + dot, absolutely positioned at
 * `top = (minutesSinceMidnight(now) / 60) * hourPx`. Mounted only inside
 * today's column by `DayWeekTimeGrid`, so its mere presence signals that the
 * visible window includes today.
 */
export function NowIndicator({ now, hourPx }: NowIndicatorProps): JSX.Element {
  const top = (minutesSinceMidnight(now) / 60) * hourPx;
  return (
    <div
      data-testid="automations-calendar-now-indicator"
      className="pointer-events-none absolute right-0 left-0 z-20 flex items-center"
      style={{ top }}
    >
      <span className="-ml-1 h-2 w-2 rounded-full bg-destructive" />
      <span className="h-0.5 flex-1 bg-destructive" />
    </div>
  );
}
