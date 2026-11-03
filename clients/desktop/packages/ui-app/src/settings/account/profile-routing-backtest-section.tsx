'use client';

import { SettingsSelect } from '@canopy/ui-shared/components';
import { useId, useState, type JSX } from 'react';
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
  const rangeLabelId = useId();
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
          <span className="flex items-center gap-2 text-xs fg-secondary">
            <span id={rangeLabelId}>Range</span>
            <SettingsSelect
              aria-labelledby={rangeLabelId}
              value={String(rangeMs)}
              onValueChange={(value) => setRangeMs(Number(value))}
              data-testid="profile-routing-backtest-range"
              options={RANGE_OPTIONS.map((option) => ({
                value: String(option.ms),
                label: option.label,
              }))}
            />
          </span>
        }
      />
    </section>
  );
}
