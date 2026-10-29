import { type JSX } from 'react';
import type { UsageTabSummaryResponse } from '@canopy/desktop-shared/types';
import type { HeadlineCardSpec } from './tab-specs';
import { HeadlineCard } from './HeadlineCard';

interface HeadlineCardRowProps {
  specs: ReadonlyArray<HeadlineCardSpec>;
  summary: UsageTabSummaryResponse;
}

export function HeadlineCardRow({
  specs,
  summary,
}: HeadlineCardRowProps): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {specs.map((spec) => {
        const card = summary.cards.find((c) => c.key === spec.key) ?? {
          key: spec.key,
        };
        return (
          <HeadlineCard
            key={spec.key}
            spec={spec}
            card={card}
            earliestEventAt={summary.earliestEventAt}
          />
        );
      })}
    </div>
  );
}
