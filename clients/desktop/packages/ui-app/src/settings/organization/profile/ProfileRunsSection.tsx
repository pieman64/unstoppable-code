'use client';

import { type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsListSkeleton,
} from '@canopy/ui-shared/components';
import { MostExpensiveRuns } from '../statistics/MostExpensiveRuns';
import { useMemberUsage } from './useMemberUsage';
import { UsageRangeSelect } from './UsageRangeSelect';
import { useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';

interface ProfileRunsSectionProps {
  orgId: string;
  userId: string;
  /**
   * Whether the viewer clears the org's `usageStatsMinRole`. When false the
   * whole tab is the restricted notice — runs are cost data and stay gated.
   */
  viewerCanViewStats: boolean;
  memberName: string;
}

/**
 * Runs tab: the subject's most expensive agent runs for a selectable range,
 * gated on the org's usage-stats threshold (same gate as the Overview headline
 * stats). This is the deeper cost breakdown that used to sit on the Overview
 * before the activity feed took that spot.
 */
export function ProfileRunsSection({
  orgId,
  userId,
  viewerCanViewStats,
  memberName,
}: ProfileRunsSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const { usage, loading, error, rangeMs, setRangeMs, retry } = useMemberUsage(
    orgId,
    userId,
    viewerCanViewStats,
  );

  if (!viewerCanViewStats) {
    return (
      <p
        className={joinClassNames(
          'rounded-xl border border-dashed px-4 py-12 text-center text-s fg-secondary',
          blockClassName,
        )}
        data-testid="profile-runs-stats-hidden"
      >
        Usage statistics for {memberName} are restricted by this team&apos;s
        settings.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-5" data-testid="profile-runs">
      <div className="flex items-end justify-between gap-3">
        <h2 className="text-s font-semibold fg-primary">
          Most expensive sessions
        </h2>
        <UsageRangeSelect
          rangeMs={rangeMs}
          onChange={setRangeMs}
          testId="profile-runs-range"
        />
      </div>

      <ErrorBanner
        error={error?.copy}
        details={error?.details}
        onRetry={retry}
      />

      {loading && !usage ? (
        <div data-testid="profile-runs-loading">
          <DelayedLoadingPlaceholder>
            <SettingsListSkeleton />
          </DelayedLoadingPlaceholder>
        </div>
      ) : error ? null : !usage ? (
        <p
          className="rounded-xl border border-dashed px-4 py-12 text-center text-s fg-secondary"
          data-testid="profile-runs-empty"
        >
          No usage data available for this range.
        </p>
      ) : (
        <div className="rounded-xl bg-card p-4 shadow-sm">
          <MostExpensiveRuns runs={usage.mostExpensiveRuns} />
        </div>
      )}
    </section>
  );
}
