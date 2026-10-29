'use client';

import type { JSX } from 'react';
import { SettingsLink, useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';
import { ListChecks } from '@canopy/ui-shared/icons/AppIcons';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  LoadingSpinner,
  SettingsListSkeleton,
} from '@canopy/ui-shared/components';
import { formatApprovedPlanMeta } from '@canopy/protocol/settings/plan-display';
import { fetchMemberApprovedPlans } from './profile-api';
import { useMemberPagedResource } from './use-member-paged-resource';

interface ProfileApprovedPlansSectionProps {
  orgId: string;
  userId: string;
  /** Display name of the subject, used in the empty-state copy. */
  memberName: string;
}

/**
 * The approved (telemetry) plans a member has started implementing in this org,
 * newest-first. Each row links to the read-only `/plans/implemented/{id}` viewer.
 * These are point-in-time snapshots distinct from the shared plans above, gated
 * by the same membership check the API enforces.
 */
export function ProfileApprovedPlansSection({
  orgId,
  userId,
  memberName,
}: ProfileApprovedPlansSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const {
    items: plans,
    initialLoaded,
    loadingMore,
    error,
    hasMore,
    loadMore,
    retry,
  } = useMemberPagedResource(orgId, userId, fetchMemberApprovedPlans);

  if (!initialLoaded) {
    return (
      <div data-testid="profile-approved-plans-loading">
        <DelayedLoadingPlaceholder>
          <SettingsListSkeleton />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {error ? (
          <ErrorBanner error={error} onRetry={retry} />
        ) : (
          <p
            className={joinClassNames(
              'rounded-xl border border-dashed px-4 py-12 text-center text-s fg-secondary',
              blockClassName,
            )}
            data-testid="profile-approved-plans-empty"
          >
            {memberName} hasn&apos;t started implementing any plans yet.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul
        className="flex flex-col gap-2"
        data-testid="profile-approved-plans-list"
      >
        {plans.map((plan) => {
          const meta = formatApprovedPlanMeta(plan);
          return (
            <li key={plan.id}>
              <SettingsLink
                href={`/plans/implemented/${encodeURIComponent(plan.id)}`}
                data-testid="profile-approved-plan-row"
                className="flex items-start gap-3 rounded-xl bg-card p-4 shadow-sm transition-colors hover:bg-secondary/40"
              >
                <span className="mt-0.5 shrink-0 fg-accent">
                  <ListChecks size={18} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-s font-medium fg-primary">
                    {plan.title}
                  </span>
                  {meta.length > 0 && (
                    <span className="mt-0.5 block truncate text-xs fg-secondary">
                      {meta.join(' · ')}
                    </span>
                  )}
                </span>
              </SettingsLink>
            </li>
          );
        })}
      </ul>

      {error && <ErrorBanner error={error} onRetry={retry} />}

      {hasMore && (
        <div className="flex justify-center py-2">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="profile-approved-plans-load-more"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? (
              <>
                <LoadingSpinner />
                <span className="sr-only">Loading more</span>
              </>
            ) : (
              'Load more'
            )}
          </button>
        </div>
      )}
    </div>
  );
}
