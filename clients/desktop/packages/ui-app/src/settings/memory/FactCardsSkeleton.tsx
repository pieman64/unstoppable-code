import type { JSX } from 'react';
import type { ExplorerFact } from '@canopy/protocol/settings/organization-memory';
import { Skeleton } from '@canopy/ui-shared/components';
import { FactCard } from './FactCard';

/** Sample facts for the loading state: plain, of the loaded shape. */
const SAMPLE_FACTS: readonly ExplorerFact[] = [
  {
    id: 'sample-fact-1',
    factText: 'A sample fact about how the team works.',
    evidenceType: 'OBSERVED',
    evidenceQuote: null,
    validAt: null,
    invalidAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiredAt: null,
    invalidatedById: null,
    liveness: 'live',
    entities: [],
  },
  {
    id: 'sample-fact-2',
    factText: 'Another sample fact.',
    evidenceType: 'OBSERVED',
    evidenceQuote: null,
    validAt: null,
    invalidAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiredAt: null,
    invalidatedById: null,
    liveness: 'live',
    entities: [],
  },
];

/** The loaded list's layout: the corpus grid or the selection column. */
const LIST_LAYOUT_CLASS = {
  grid: 'grid gap-3 lg:grid-cols-2',
  column: 'flex flex-col gap-3',
} as const;

interface FactCardsSkeletonProps {
  /** Lays the cards out like the list they stand in for. */
  readonly layout: keyof typeof LIST_LAYOUT_CLASS;
}

/**
 * Fact cards while they load: the real cards with sample facts inside
 * `Skeleton`, so skullet measures them into bars and the loaded cards
 * replace them in place.
 */
export function FactCardsSkeleton({
  layout,
}: FactCardsSkeletonProps): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading memory facts"
      testId="settings-skeleton-list"
      className="w-full"
    >
      <div className={LIST_LAYOUT_CLASS[layout]}>
        {SAMPLE_FACTS.map((fact) => (
          <FactCard key={fact.id} fact={fact} />
        ))}
      </div>
    </Skeleton>
  );
}
