import { type JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import type { WorkflowRunFeed } from './useWorkflowRunFeed';
import { useWorkflowRunRowActions, WorkflowRunsList } from './WorkflowRunsList';

export interface WorkflowsRunsTabProps {
  readonly feed: WorkflowRunFeed;
  /** Each is omitted when the action is unavailable here. */
  /** Starts a run; absent when the Library has nothing to run. */
  readonly onRunWorkflow?: () => void;
  readonly onNewWorkflow?: () => void;
}

/**
 * Workflows → Runs (CAN-3981): pipeline runs, automation runs and watchers in
 * one feed. Every action goes to the handler that already owns it, and always
 * carries the row's own id.
 */
export function WorkflowsRunsTab({
  feed,
  onRunWorkflow,
  onNewWorkflow,
}: WorkflowsRunsTabProps): JSX.Element {
  const query = useWorkflowsViewStore((state) => state.runsQuery);
  const filters = useWorkflowsViewStore((state) => state.runsFilters);
  const setQuery = useWorkflowsViewStore((state) => state.setRunsQuery);
  const setFilters = useWorkflowsViewStore((state) => state.setRunsFilters);
  const rowActions = useWorkflowRunRowActions(feed);

  // Older pages hold automation runs only.
  const hasMore =
    feed.hasMore && (filters.kind === null || filters.kind === 'automation');

  return (
    <div
      ref={rowActions.dialogAnchorRef}
      className="flex flex-col gap-4 pt-4"
      data-testid="workflows-runs"
    >
      {feed.error !== null && (
        <Notice intent="destructive" data-testid="workflows-runs-error">
          On-demand workflow runs could not be loaded. Scheduled workflow runs
          and watchers are still listed.
        </Notice>
      )}
      <WorkflowRunsList
        rows={feed.rows}
        loading={feed.loading}
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        onOpen={rowActions.openRow}
        onAction={rowActions.handleAction}
        busyKeys={rowActions.busyKeys}
        hasMore={hasMore}
        loadingMore={feed.loadingMore}
        onLoadMore={feed.loadMore}
        onRunWorkflow={onRunWorkflow}
        onNewWorkflow={onNewWorkflow}
        onBrowseMarketplace={(): void =>
          useNavigationStore.getState().navigate('plugins')
        }
      />
      {feed.loadMoreFailed && (
        <Notice intent="attention" data-testid="workflows-runs-load-more-error">
          Some older automation runs could not be loaded. Load more to try
          again.
        </Notice>
      )}
      {rowActions.dialogs}
    </div>
  );
}
