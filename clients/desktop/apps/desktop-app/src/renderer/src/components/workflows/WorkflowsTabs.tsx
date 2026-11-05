import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { ScheduledActivityRun } from '@canopy/desktop-shared/types';
import { NewWorkflowMenu } from '@canopy/ui-app/workflows';
import { OnboardingTipSlot } from '@canopy/ui-app/onboarding-tips';
import type { OnboardingTipId } from '@canopy/protocol/onboarding-tips';
import { Button, Tooltip } from '@canopy/ui-shared';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import { useDispatchPipelineModal } from '../activity/useDispatchPipelineModal';
import {
  openAutomationRunDestination,
  resolveAutomationRunDestination,
  resolveAvailableAutomationRunDestination,
} from '../automations/resolveAutomationRunDestination';
import type { AutomationsPageBodyApi } from '../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../pages/PipelinesPage';
import { useNowTick } from '../automations/calendar/useNowTick';
import { RefreshSpinner } from '../shared/loading/spinners/RefreshSpinner';
import { PageContent } from '../shared/PageContent';
import { PageTitlebar } from '../shared/PageTitlebar';
import { useWorkflowLibraryRows } from './library/useWorkflowLibraryRows';
import { WorkflowsLibraryTab } from './library/WorkflowsLibraryTab';
import { useWorkflowRunFeed } from './runs/useWorkflowRunFeed';
import { WorkflowsRunsTab } from './runs/WorkflowsRunsTab';
import { WorkflowsScheduleTab } from './schedule/WorkflowsScheduleTab';
import { WorkflowsPageHeader } from './WorkflowsPageHeader';
import { WorkflowsTabPanel } from './WorkflowsTabPanel';

export interface WorkflowsTabsProps {
  readonly tab: WorkflowsTabId;
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
}

const TAB_NAMES: Readonly<
  Record<WorkflowsTabId, 'runs' | 'schedule' | 'library'>
> = {
  workflows: 'runs',
  'workflows-schedule': 'schedule',
  'workflows-library': 'library',
};

/**
 * The tips each tab can show, highest priority first (CAN-4904). The
 * Workflows tip applies to the whole page, so on Schedule it shows first and
 * the Schedule tip waits for a later visit.
 */
const TAB_TIPS: Readonly<Record<WorkflowsTabId, readonly OnboardingTipId[]>> = {
  workflows: ['workflows'],
  'workflows-schedule': ['workflows', 'workflows-schedule'],
  'workflows-library': ['workflows'],
};

const TIP_ACTIONS: Partial<Record<OnboardingTipId, () => void>> = {
  'workflows-schedule': (): void =>
    useNavigationStore.getState().navigate('workflows-library'),
};

function showError(message: string): void {
  useGitHubStore
    .getState()
    .addToast(message, 'error', undefined, { category: 'Automation' });
}

/**
 * Opens what one automation run did: its chat, or the run it started. A run
 * with nothing to open falls back to `onNothingToOpen`, when it handles it.
 */
async function openAutomationRun(
  run: ScheduledActivityRun,
  onNothingToOpen: (run: ScheduledActivityRun) => boolean,
): Promise<void> {
  const destination = await resolveAvailableAutomationRunDestination(
    resolveAutomationRunDestination(run),
  );
  if (destination.kind === 'none') {
    if (!onNothingToOpen(run)) showError(destination.reason);
    return;
  }
  const result = await openAutomationRunDestination(destination);
  if (!result.ok) showError(result.error);
}

/**
 * The Workflows page body (CAN-3981): the heading, the Runs | Schedule |
 * Library tabs and the tab shown. One element for all three, so switching
 * tabs keeps the loaded lists and an open dialog.
 */
export function WorkflowsTabs({
  tab,
  pipelines,
  automations,
}: WorkflowsTabsProps): JSX.Element {
  const feed = useWorkflowRunFeed({
    activities: automations.activities,
    recentRuns: automations.recentRuns,
    scope: automations.scope,
    automationsLoading: automations.loading,
  });
  const executions = useExecutionFeedStore((state) => state.executions);
  // One clock for the tab shown, advancing each minute.
  const now = useNowTick().getTime();
  const library = useWorkflowLibraryRows(
    pipelines,
    automations,
    executions,
    now,
  );

  // The calendar keeps runs of a deleted automation, but not those of an
  // automation the selected context hides.
  const scheduleRuns = useMemo(() => {
    const shown = new Set(
      automations.scopedActivities.map((activity) => activity.id),
    );
    const known = new Set(
      automations.activities.map((activity) => activity.id),
    );
    return automations.recentRuns.filter(
      (run) => shown.has(run.activityId) || !known.has(run.activityId),
    );
  }, [
    automations.activities,
    automations.recentRuns,
    automations.scopedActivities,
  ]);

  // A calendar run with nothing to open shows its automation's run history,
  // as every calendar chip did before the run result became the target.
  const { activities: allActivities, beginView } = automations;
  const showRunHistory = useCallback(
    (run: ScheduledActivityRun): boolean => {
      const activity = allActivities.find(
        (candidate) => candidate.id === run.activityId,
      );
      if (!activity) return false;
      beginView(activity);
      return true;
    },
    [allActivities, beginView],
  );

  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const { openWorkflowsRunModal, dispatchPipelineModal } =
    useDispatchPipelineModal();
  // Run needs no selected task: a global pipeline runs with no project.
  const runPipeline = useCallback(
    (pipelineId?: string): void => {
      openWorkflowsRunModal({
        ...(pipelineId !== undefined ? { initialPipelineId: pipelineId } : {}),
        ...(selectedWorktree
          ? {
              currentTarget: {
                projectId: selectedWorktree.projectId,
                worktreeId: selectedWorktree.worktreeId,
              },
            }
          : {}),
      });
    },
    [openWorkflowsRunModal, selectedWorktree],
  );

  // The Personal/organization context changed: page 1, and no Project filter
  // that names a project the new context does not list.
  const { scope } = automations;
  const contextKey =
    scope.context === undefined
      ? 'unscoped'
      : scope.context.kind === 'personal'
        ? 'personal'
        : scope.context.organizationId;
  // The view store remembers the context its filters were chosen in, so a
  // switch made on another page is caught when Workflows next opens.
  useEffect(() => {
    useWorkflowsViewStore
      .getState()
      .resetForContext(
        contextKey,
        new Set(scope.projectsInContext.map((project) => project.id)),
      );
  }, [contextKey, scope.projectsInContext]);

  // Leaving the Library ends a reveal, as leaving the Automations tab did, so
  // coming back does not clear the filters and move focus again.
  const { endReveal } = automations;
  useEffect(() => {
    if (tab !== 'workflows-library') endReveal();
  }, [endReveal, tab]);

  // Runs keeps its scroll position across opening a run and coming Back.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The tabs share this scroll container, so the others open at the top.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop =
      tab === 'workflows' ? useWorkflowsViewStore.getState().runsScrollTop : 0;
  }, [tab]);
  const handleScroll = useCallback((): void => {
    if (tab !== 'workflows' || !scrollRef.current) return;
    useWorkflowsViewStore
      .getState()
      .setRunsScrollTop(scrollRef.current.scrollTop);
  }, [tab]);

  const runsQuery = useWorkflowsViewStore((state) => state.runsQuery);
  const runsFilters = useWorkflowsViewStore((state) => state.runsFilters);
  const libraryFilters = useWorkflowsViewStore((state) => state.libraryFilters);
  const scheduleProject = useWorkflowsViewStore(
    (state) => state.scheduleProject,
  );
  useCurrentUiStateReporter('workflows.page', {
    tab: TAB_NAMES[tab],
    query:
      tab === 'workflows'
        ? runsQuery
        : tab === 'workflows-library'
          ? libraryFilters.query
          : '',
    filters:
      tab === 'workflows'
        ? {
            status: runsFilters.status ?? '',
            kind: runsFilters.kind ?? '',
            startedBy: runsFilters.starter ?? '',
          }
        : tab === 'workflows-library'
          ? {
              triggers: [...libraryFilters.triggers],
              status: libraryFilters.status ?? '',
              project: libraryFilters.project ?? '',
              source: libraryFilters.source ?? '',
            }
          : { project: scheduleProject ?? '' },
    activeRunCount: feed.activeCount,
    libraryCount: library.rows.length,
  });

  const [refreshing, setRefreshing] = useState(false);
  const { refreshSharedAutomations } = library;
  const refreshLibrary = useCallback((): void => {
    setRefreshing(true);
    void Promise.allSettled([
      pipelines.refresh(),
      pipelines.refreshSharedList(),
      // A share list or run listing that failed is asked for again.
      refreshSharedAutomations(),
      useExecutionFeedStore.getState().load(),
    ]).then(() => setRefreshing(false));
  }, [pipelines, refreshSharedAutomations]);

  // New workflow opens the creation view (CAN-4319): the assistant chat
  // beside the editor, with no choice to make first. The pipeline editor
  // belongs to the Library page id, so a draft started on Runs opens there.
  const newWorkflowButton = (
    <Button
      variant="primary"
      size="compact"
      data-testid="workflows-new-create"
      onClick={pipelines.createNew}
    >
      New workflow
    </Button>
  );
  // Schedule still offers what a schedule needs first: an automation, or a
  // pipeline that an automation can run.
  const newScheduledWorkflow = (
    <NewWorkflowMenu
      onSchedule={automations.beginCreate}
      onBuildPipeline={pipelines.createNew}
    />
  );
  const hasWorkflows = library.rows.length > 0;
  const actions =
    tab === 'workflows' ? (
      // Starting a workflow does not depend on having one to run, so Runs
      // offers it in every state.
      newWorkflowButton
    ) : tab === 'workflows-library' ? (
      <>
        {pipelines.headerAction}
        <Tooltip label="Refresh workflows">
          <Button
            variant="secondary"
            size="compact"
            iconOnly
            onClick={refreshLibrary}
            aria-label="Refresh workflows"
            data-testid="workflows-library-refresh"
          >
            <RefreshSpinner spinning={refreshing || pipelines.loading} />
          </Button>
        </Tooltip>
        {newWorkflowButton}
      </>
    ) : (
      newScheduledWorkflow
    );

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="page-scroll-gutter h-full overflow-auto"
      data-testid={`page-workflows-${TAB_NAMES[tab]}`}
    >
      <PageTitlebar />
      <PageContent>
        <WorkflowsPageHeader
          actions={actions}
          counts={{
            workflows: feed.activeCount,
            'workflows-library': library.rows.length,
          }}
        />
        <WorkflowsTabPanel>
          <OnboardingTipSlot
            placement="inline"
            eligible={TAB_TIPS[tab]}
            arrivalKey={tab}
            onAction={TIP_ACTIONS}
            className="mt-4"
            data-testid="workflows-onboarding-tip"
          />
          {tab === 'workflows' ? (
            <WorkflowsRunsTab
              feed={feed}
              onRunWorkflow={
                hasWorkflows ? (): void => runPipeline() : undefined
              }
              onNewWorkflow={automations.beginCreate}
              library={library}
            />
          ) : tab === 'workflows-schedule' ? (
            <WorkflowsScheduleTab
              activities={automations.scopedActivities}
              recentRuns={scheduleRuns}
              scope={automations.scope}
              describeAction={automations.describeAction}
              onEdit={automations.beginEdit}
              onOpenRun={(run): void =>
                void openAutomationRun(run, showRunHistory)
              }
            />
          ) : (
            <WorkflowsLibraryTab
              data={library}
              pipelines={pipelines}
              automations={automations}
              now={now}
              onRunPipeline={runPipeline}
              newWorkflow={newWorkflowButton}
            />
          )}
        </WorkflowsTabPanel>
      </PageContent>
      {dispatchPipelineModal}
    </div>
  );
}
