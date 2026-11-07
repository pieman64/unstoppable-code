import type { JSX } from 'react';
import { ActivitySection } from './ActivitySection';
import { SummarySectionBody } from '@canopy/ui-app';
import { RefreshButton } from '@canopy/ui-shared/components';
import { SummaryIcon as CentralSummaryIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  useActivitySectionChrome,
  type CollapsedIconColor,
} from '@/components/shared/panel-section';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { formatRelativeTime } from '@/lib/format';

// eslint-disable-next-line react-refresh/only-export-components
export function useSummaryHeaderChrome(scope?: {
  projectId: string;
  worktreeId: string;
}): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
} {
  const storedWorktree = useChatStore((state) => state.selectedWorktree);
  const selectedWorktree = scope ?? storedWorktree;
  const key = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : '';
  const summary = useActivityStore((state) =>
    key ? state.worktreeSummaries[key] : undefined,
  );
  const generating = useActivityStore((state) =>
    key ? state.summaryGenerating[key] === true : false,
  );
  return {
    subtitle: summary
      ? `Updated ${formatRelativeTime(summary.generatedAt)}`
      : generating
        ? 'Generating…'
        : 'No summary yet',
    collapsedIconColor: summary ? 'blue' : 'muted',
  };
}

export function SummarySection(): JSX.Element {
  const chrome = useActivitySectionChrome();
  const frameless = chrome === 'frameless';
  const sectionClassName = frameless ? 'flex min-h-0 flex-1 flex-col' : '';
  // In body-only chrome the shared section wrapper carries the container
  // testid (via the adapter's dataTestId override); emitting it here too
  // would duplicate the id.
  const sectionTestId =
    chrome === 'body-only' ? undefined : 'activity-summary-section';
  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const worktreeSummaryEnabled = useActivityStore(
    (state) => state.worktreeSummaryEnabled,
  );
  const refreshWorktreeSummary = useActivityStore(
    (state) => state.refreshWorktreeSummary,
  );

  const summaryKey = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : '';
  const summary = useActivityStore((state) =>
    summaryKey ? state.worktreeSummaries[summaryKey] : undefined,
  );
  const generating = useActivityStore((state) =>
    summaryKey ? state.summaryGenerating[summaryKey] === true : false,
  );
  const headerChrome = useSummaryHeaderChrome();
  if (!selectedWorktree) {
    return (
      <div data-testid={sectionTestId} className={sectionClassName}>
        <ActivitySection
          icon={<CentralSummaryIcon size="sm" />}
          title="Summary"
          subtitle={headerChrome.subtitle}
          collapsedIconColor={headerChrome.collapsedIconColor}
        />
      </div>
    );
  }

  const handleRefresh = (): void => {
    void refreshWorktreeSummary(
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
    );
  };

  const headerAction =
    worktreeSummaryEnabled || generating ? (
      <RefreshButton
        onClick={handleRefresh}
        disabled={!worktreeSummaryEnabled}
        busy={generating}
        ariaLabel={generating ? 'Refreshing summary' : 'Refresh summary'}
      />
    ) : null;

  if (!summary) {
    return (
      <div data-testid={sectionTestId} className={sectionClassName}>
        <ActivitySection
          icon={<CentralSummaryIcon size="sm" />}
          title="Summary"
          subtitle={headerChrome.subtitle}
          collapsedIconColor={headerChrome.collapsedIconColor}
          headerAction={headerAction}
        />
      </div>
    );
  }

  return (
    <div data-testid={sectionTestId} className={sectionClassName}>
      <ActivitySection
        icon={<CentralSummaryIcon size="sm" />}
        title="Summary"
        subtitle={headerChrome.subtitle}
        collapsedIconColor={headerChrome.collapsedIconColor}
        headerAction={headerAction}
      >
        <SummarySectionBody
          summary={summary}
          generating={generating}
          refreshEnabled={worktreeSummaryEnabled}
          onRefresh={handleRefresh}
        />
      </ActivitySection>
    </div>
  );
}
