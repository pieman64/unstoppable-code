'use client';

import type { JSX } from 'react';
import type { ActivitySectionId } from '@canopy/app-state';
import { Skeleton } from '@canopy/ui-shared/components';
import {
  SummarySectionBody,
  type SummarySectionBodySummary,
} from './SummarySectionBody';
import {
  ItemListSection,
  type ActivityListItem,
} from './sections/ItemListSection';

/** A short summary: a title and two lines of description. */
const SAMPLE_SUMMARY: SummarySectionBodySummary = {
  title: 'Fix the flaky checkout test',
  description:
    'Waits on the settled event instead of a fixed timeout, so the retry test no longer races the payment stub.',
};

/**
 * Two plain rows of the generic list the data-bearing sections (plans,
 * pipeline runs, scripts, hooks, terminals) render.
 */
const SAMPLE_ITEMS: readonly ActivityListItem[] = [
  { key: 'sample-1', label: 'Run the unit tests', detail: 'Finished' },
  { key: 'sample-2', label: 'Build the app', detail: 'Finished' },
];

/**
 * A section body that has not arrived while the host hydrates: the section's
 * own body, rendered from plain samples inside the measured `Skeleton`, so
 * the bars sit where the content will. The summary measures its summary
 * body; every other section the generic item list.
 */
export function ActivitySectionSkeleton({
  id,
}: {
  readonly id: ActivitySectionId;
}): JSX.Element {
  return (
    <Skeleton loading label="Loading" testId="activity-section-loading">
      <div className="py-1">
        {id === 'summary' ? (
          <SummarySectionBody
            summary={SAMPLE_SUMMARY}
            generating={false}
            refreshEnabled={false}
          />
        ) : (
          <ItemListSection items={SAMPLE_ITEMS} emptyLabel="" />
        )}
      </div>
    </Skeleton>
  );
}
