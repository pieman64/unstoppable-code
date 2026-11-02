'use client';

import type { JSX } from 'react';
import { Workflow } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  LoadingSpinner,
  SettingsListSkeleton,
} from '@canopy/ui-shared/components';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { fetchMemberSharedPipelines } from './profile-api';
import { useMemberPagedResource } from './use-member-paged-resource';
import { useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';

interface ProfilePipelinesSectionProps {
  orgId: string;
  userId: string;
  /** Display name of the subject, used in the empty-state copy. */
  memberName: string;
}

/**
 * The member's TEAM/ORGANIZATION-shared pipelines in this org, newest-updated
 * first. The web Portal has no pipeline detail route today, so rows are
 * read-only info cards (name + description) rather than links. Visible to every
 * org member regardless of the usage-stats threshold.
 */
export function ProfilePipelinesSection({
  orgId,
  userId,
  memberName,
}: ProfilePipelinesSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const {
    items: pipelines,
    initialLoaded,
    loadingMore,
    error,
    hasMore,
    loadMore,
    retry,
  } = useMemberPagedResource(orgId, userId, fetchMemberSharedPipelines);

  if (!initialLoaded) {
    return (
      <div data-testid="profile-pipelines-loading">
        <DelayedLoadingPlaceholder>
          <SettingsListSkeleton />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  if (pipelines.length === 0) {
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
            data-testid="profile-pipelines-empty"
          >
            {memberName} hasn&apos;t shared any workflows with this team yet.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" data-testid="profile-pipelines-list">
        {pipelines.map((pipeline) => {
          const description = markdownDescriptionToPlainText(
            pipeline.description,
          );
          return (
            <li
              key={pipeline.id}
              data-testid="profile-pipeline-row"
              className="flex items-start gap-3 rounded-xl bg-card p-4 shadow-sm"
            >
              <span className="mt-0.5 shrink-0 fg-accent">
                <Workflow size={18} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-s font-medium fg-primary">
                  {pipeline.name}
                </span>
                {description && (
                  <span className="mt-0.5 block truncate text-xs fg-secondary">
                    {description}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {error && <ErrorBanner error={error} onRetry={retry} />}

      {hasMore && (
        <div className="flex justify-center py-2">
          <Button
            size="compact"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="profile-pipelines-load-more"
          >
            {loadingMore ? (
              <>
                <LoadingSpinner />
                <span className="sr-only">Loading more</span>
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
