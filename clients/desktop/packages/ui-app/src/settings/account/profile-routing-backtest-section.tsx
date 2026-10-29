'use client';
import { SettingsControlSelect } from '@canopy/ui-shared/components';

import { useState, type JSX } from 'react';
import { RoutingBacktestCard } from '../organization/statistics/RoutingBacktestCard';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RANGE_OPTIONS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 7 * MS_PER_DAY, label: 'Last 7 days' },
  { ms: 30 * MS_PER_DAY, label: 'Last 30 days' },
  { ms: 90 * MS_PER_DAY, label: 'Last 90 days' },
];

/**
 * The automatic model routing estimate over the signed-in person's own turns,
 * paid from their own AI Credits. The range picker sits inside the card so it
 * hides with the card when the feature is off for them.
 */
export function ProfileRoutingBacktestSection(): JSX.Element {
  const [rangeMs, setRangeMs] = useState(RANGE_OPTIONS[1].ms);
  const rangeLabel =
    RANGE_OPTIONS.find((option) => option.ms === rangeMs)?.label ?? '';
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="profile-routing-backtest-section"
    >
      <RoutingBacktestCard
        subject={{ kind: 'user' }}
        rangeMs={rangeMs}
        rangeLabel={rangeLabel}
        billingHref="/account/billing"
        controls={
          <label className="flex items-center gap-2 text-xs fg-secondary">
            Range
            <SettingsControlSelect
              value={String(rangeMs)}
              onChange={(event) => setRangeMs(Number(event.target.value))}
              data-testid="profile-routing-backtest-range"
            >
              {RANGE_OPTIONS.map((option) => (
                <option key={option.ms} value={String(option.ms)}>
                  {option.label}
                </option>
              ))}
            </SettingsControlSelect>
          </label>
        }
      />
    </section>
  );
}
