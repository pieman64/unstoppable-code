'use client';

import type { JSX } from 'react';
import type { FeedItem } from '@canopy/protocol';
import { Skeleton } from '@canopy/ui-shared/components';
import { FeedItemCard } from './team-feed-cards';

const SAMPLE_TIME = '2026-01-01T12:00:00.000Z';

/**
 * Plain sample cards: a short title or branch per card, with no chips,
 * summaries or links beyond the card's own chrome.
 */
const SAMPLE_FEED_ITEMS: readonly FeedItem[] = [
  {
    id: 'sample-feed-item-1',
    type: 'plan_shared',
    occurredAt: SAMPLE_TIME,
    actor: { userId: 'sample-actor', displayName: 'Sample member' },
    worktreeId: null,
    sharedPlanId: 'sample-plan',
    title: 'Checkout retry fix',
    shareScope: 'organization',
  },
  {
    id: 'sample-feed-item-2',
    type: 'worktree_started',
    occurredAt: SAMPLE_TIME,
    actor: { userId: 'sample-actor', displayName: 'Sample member' },
    worktreeId: null,
    branchName: 'fix-checkout',
    workspaceName: 'Web app',
  },
];

interface TeamFeedSkeletonProps {
  orgId: string;
  /** What the status region announces while loading. */
  label: string;
}

/**
 * The activity feed's loading state: the feed's own cards with sample data
 * inside `Skeleton`, so skullet measures them into bars and the loaded feed
 * replaces the skeleton in place.
 */
export function TeamFeedSkeleton({
  orgId,
  label,
}: TeamFeedSkeletonProps): JSX.Element {
  return (
    <Skeleton loading label={label} testId="settings-skeleton-list">
      <div className="flex flex-col gap-3">
        {SAMPLE_FEED_ITEMS.map((item) => (
          <FeedItemCard key={item.id} item={item} orgId={orgId} />
        ))}
      </div>
    </Skeleton>
  );
}
