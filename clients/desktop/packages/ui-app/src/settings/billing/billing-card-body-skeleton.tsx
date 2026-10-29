import type { JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  SkeletonBlock,
} from '@canopy/ui-shared/components';

/**
 * The body of a billing card whose title is already on screen while its
 * figures load: the card-skeleton bars (a value line, then two text lines)
 * without a second border, so the card's own chrome holds the shape. Like
 * the shared settings skeletons it has no visible text, announces "Loading"
 * to assistive technology only, and shows only after the shared delay.
 */
export function BillingCardBodySkeleton({
  className = '',
}: {
  /** Placement only: the gap from the card title above. */
  readonly className?: string;
}): JSX.Element {
  return (
    <DelayedLoadingPlaceholder className={className}>
      <div
        role="status"
        data-testid="settings-skeleton-card-body"
        className="flex flex-col gap-3"
      >
        <span className="sr-only">Loading</span>
        <SkeletonBlock height="value" width="2/5" />
        <SkeletonBlock width="5/6" />
        <SkeletonBlock width="3/5" />
      </div>
    </DelayedLoadingPlaceholder>
  );
}
