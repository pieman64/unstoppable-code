import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useOverviewStore } from '@canopy/app-state';
import type { PortalPipelineRunProjection } from '@canopy/protocol/portal';
import { Overview } from '@canopy/ui-app';
import { useShallow } from 'zustand/react/shallow';
import { PageTitlebar } from '../shared/PageTitlebar';
import { NotificationsPanel } from '@/components/overview/NotificationsPanel';
import { OverviewEmptyState } from '@/components/overview/OverviewEmptyState';
import { WorkspaceReadinessOverview } from '@/components/overview/WorkspaceReadinessOverview';
import { MobileAppPromoCard } from '@/components/overview/MobileAppPromoCard';
import { openOverviewPipelineExecution } from '@/components/overview/openOverviewPipelineExecution';
import { DagProgressBar } from '@/components/activity/DagProgressBar';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import {
  hasNoCodeWorkspaces,
  shouldRenderWorkspaceReadiness,
} from '@/components/home/homeGating';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import {
  overviewChatRouteAction,
  projectDesktopOverview,
} from '@/lib/desktopOverviewProjector';
import { selectRunningExecutionIdsMissingState } from '@/lib/overviewSelectors';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { findPlanExploreTarget, useChatStore } from '@/stores/chatStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { openInWorkspaceContext } from '@/lib/contextScope';

const HYDRATE_PARALLELISM = 4;

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  parallelism: number,
): Promise<void> {
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  const workerCount = Math.max(1, Math.min(parallelism, queue.length));
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async (): Promise<void> => {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) return;
          try {
            await task();
          } catch {
            // Individual detail failures are non-fatal; the card retains its
            // lightweight loading/skeleton treatment.
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}

export function OverviewPage(): JSX.Element {
  // First-run detection stays desktop-owned: the shared Overview is an
  // attention dashboard, while the desktop host owns onboarding and modal
  // composition.
  const hasHydratedProjects = useProjectsStore((s) => s.hasHydratedProjects);
  const allProjects = useProjectsStore((s) => s.projects);
  const { context, workspaces: contextProjects } = useContextScopedWorkspaces();
  const [contextFilter, setContextFilter] = useState<'context' | 'all'>(
    'context',
  );
  const projects = contextFilter === 'all' ? allProjects : contextProjects;
  const isFirstRun = hasHydratedProjects && hasNoCodeWorkspaces(projects);
  const showWorkspaceReadiness = shouldRenderWorkspaceReadiness(
    projects,
    hasHydratedProjects,
  );

  const {
    worktreeChats,
    unreadWorktreeKeys,
    selectWorktree,
    switchTab,
    dismissOverviewChatCard,
  } = useChatStore(
    useShallow((s) => ({
      worktreeChats: s.worktreeChats,
      unreadWorktreeKeys: s.unreadWorktreeKeys,
      selectWorktree: s.selectWorktree,
      switchTab: s.switchTab,
      dismissOverviewChatCard: s.dismissOverviewChatCard,
    })),
  );
  const {
    runningExecutionsByWorktree,
    unseenPipelineWorktreeKeys,
    pipelineSummariesByWorktree,
    statesById,
    loadExecutionDetails,
    markWorktreePipelineSeen,
  } = usePipelineRunsStore(
    useShallow((s) => ({
      runningExecutionsByWorktree: s.runningExecutionsByWorktree,
      unseenPipelineWorktreeKeys: s.unseenPipelineWorktreeKeys,
      pipelineSummariesByWorktree: s.pipelineSummariesByWorktree,
      statesById: s.statesById,
      loadExecutionDetails: s.loadExecutionDetails,
      markWorktreePipelineSeen: s.markWorktreePipelineSeen,
    })),
  );
  const hydratedPipelineIdsRef = useRef<Set<string>>(new Set());

  // Shared pipeline cards still use desktop ExecutionState for rich DAG
  // progress and exact job navigation. Hydrate new running executions with
  // bounded concurrency as they appear while this page remains mounted.
  useEffect(() => {
    const missing = selectRunningExecutionIdsMissingState(
      runningExecutionsByWorktree,
      statesById,
    ).filter((id) => !hydratedPipelineIdsRef.current.has(id));
    if (missing.length === 0) return;

    for (const id of missing) {
      hydratedPipelineIdsRef.current.add(id);
    }
    void runWithConcurrency(
      missing.map((id) => (): Promise<unknown> => loadExecutionDetails(id)),
      HYDRATE_PARALLELISM,
    );
  }, [loadExecutionDetails, runningExecutionsByWorktree, statesById]);

  const projection = useMemo(
    () =>
      projectDesktopOverview({
        projects,
        worktreeChats,
        unreadWorktreeKeys,
        runningExecutionsByWorktree,
        unseenPipelineWorktreeKeys,
        pipelineSummariesByWorktree,
        resolvePlanExplore: (planId) =>
          findPlanExploreTarget(planId) ?? undefined,
      }),
    [
      pipelineSummariesByWorktree,
      projects,
      runningExecutionsByWorktree,
      unseenPipelineWorktreeKeys,
      unreadWorktreeKeys,
      worktreeChats,
    ],
  );
  const hydrateOverview = useOverviewStore((s) => s.hydrate);
  useEffect(() => {
    hydrateOverview(projection.snapshot);
  }, [hydrateOverview, projection.snapshot]);

  const navigate = useNavigationStore((s) => s.navigate);
  const openAddWorkspaceModal = useNavigationStore(
    (s) => s.openAddWorkspaceModal,
  );

  const handleCreateWorkspace = useCallback((): void => {
    navigate('main');
    openAddWorkspaceModal();
  }, [navigate, openAddWorkspaceModal]);

  const handleStartChat = useCallback((): void => {
    navigate('chat');
  }, [navigate]);

  const handleSelectWorktree = useCallback(
    (workspaceLocalId: string, worktreeLocalId: string): void => {
      openInWorkspaceContext(workspaceLocalId, (): void => {
        const route = projection.chatRoutes[worktreeLocalId];
        const action = route ? overviewChatRouteAction(route) : undefined;
        if (action?.kind === 'none') return;
        if (action?.kind === 'plan') {
          // The opener brings the plan's worktree on screen itself.
          void openTrackedPlan(action.ref);
          return;
        }
        // Explicit navigation to a live worktree dismisses the page-like
        // archived viewer overlaying the main page.
        dismissPageLikeViewers();
        navigate('main');
        if (!action) {
          selectWorktree(workspaceLocalId, worktreeLocalId);
          return;
        }
        selectWorktree(action.projectId, action.worktreeId);
        switchTab(action.tabId);
        requestChatPanelReveal(
          action.projectId,
          action.worktreeId,
          action.tabId,
        );
      });
    },
    [navigate, projection.chatRoutes, selectWorktree, switchTab],
  );

  const handleDismissWorktree = useCallback(
    (_workspaceLocalId: string, worktreeLocalId: string): void => {
      const route = projection.chatRoutes[worktreeLocalId];
      if (!route) return;
      dismissOverviewChatCard(route.projectId, route.worktreeId, route.tabId);
    },
    [dismissOverviewChatCard, projection.chatRoutes],
  );

  const handleSelectPipelineRun = useCallback(
    (run: PortalPipelineRunProjection, unread: boolean): void => {
      if (!run.workspaceLocalId || !run.worktreeLocalId || !run.localId) return;
      const projectId = run.workspaceLocalId;
      const worktreeId = run.worktreeLocalId;
      const executionId = run.localId;
      openInWorkspaceContext(projectId, (): void => {
        void openOverviewPipelineExecution({
          projectId,
          worktreeId,
          executionId,
          markSeen: unread,
        });
      });
    },
    [],
  );

  const handleDismissPipelineRun = useCallback(
    (run: PortalPipelineRunProjection): void => {
      if (!run.workspaceLocalId || !run.worktreeLocalId) return;
      markWorktreePipelineSeen(
        `${run.workspaceLocalId}/${run.worktreeLocalId}`,
      );
    },
    [markWorktreePipelineSeen],
  );

  const renderPipelineRunDetails = useCallback(
    (run: PortalPipelineRunProjection, unread: boolean): ReactNode => {
      if (!run.workspaceLocalId || !run.worktreeLocalId || !run.localId) {
        return null;
      }
      const projectId = run.workspaceLocalId;
      const worktreeId = run.worktreeLocalId;
      const executionId = run.localId;
      const state = statesById[executionId];
      const hiddenCount = projection.pipelineHiddenCounts[executionId];
      return (
        <div className="mt-1 flex flex-col gap-1">
          {state ? (
            <DagProgressBar
              executionState={state}
              muted={unread}
              onJobClick={(jobId): void =>
                openInWorkspaceContext(projectId, (): void => {
                  void openOverviewPipelineExecution({
                    projectId,
                    worktreeId,
                    executionId,
                    jobId,
                    markSeen: unread,
                  });
                })
              }
            />
          ) : unread ? (
            <div className="h-1.5 w-full rounded-full bg-muted/50" />
          ) : (
            <div className="flex items-center gap-2 text-xs fg-secondary">
              <LoadingSpinner sizePx={12} />
              <span>Loading pipeline details…</span>
            </div>
          )}
          {hiddenCount !== undefined && hiddenCount > 0 && (
            <span className="text-2xs fg-secondary">
              +{hiddenCount} more in this worktree
            </span>
          )}
        </div>
      );
    },
    [projection.pipelineHiddenCounts, statesById],
  );

  if (isFirstRun) {
    return (
      <div
        className="page-scroll-gutter flex min-h-full flex-col overflow-y-auto"
        data-testid="overview-page"
      >
        <PageTitlebar />
        <OverviewEmptyState
          onCreateWorkspace={handleCreateWorkspace}
          onStartChat={handleStartChat}
        />
      </div>
    );
  }

  return (
    <div
      className="page-scroll-gutter flex min-h-full flex-col overflow-y-auto"
      data-testid="overview-page"
    >
      <PageTitlebar />
      {context !== undefined && (
        <div className="flex justify-end px-6 pt-4">
          <label className="flex items-center gap-2 text-xs fg-secondary">
            <span>Scope</span>
            <select
              data-testid="overview-context-filter"
              value={contextFilter}
              onChange={(event) =>
                setContextFilter(
                  event.target.value === 'all' ? 'all' : 'context',
                )
              }
              className="focus-ring rounded-md border bg-base px-3 py-2 text-s fg-primary"
            >
              <option value="context">Selected context</option>
              <option value="all">All contexts</option>
            </select>
          </label>
        </div>
      )}
      <Overview
        className="flex-1"
        layout="page"
        onSelectWorktree={handleSelectWorktree}
        onDismissWorktree={handleDismissWorktree}
        onSelectPipelineRun={handleSelectPipelineRun}
        onDismissPipelineRun={handleDismissPipelineRun}
        renderPipelineRunDetails={renderPipelineRunDetails}
        notifications={
          <NotificationsPanel showAllContexts={contextFilter === 'all'} />
        }
        recommendations={
          // The `recommendations` slot is a single node, so compose: readiness
          // first (actionable), mobile-app promo second (a nudge).
          <div className="space-y-4">
            {showWorkspaceReadiness && (
              <WorkspaceReadinessOverview
                projects={projects}
                hasHydratedProjects={hasHydratedProjects}
              />
            )}
            <MobileAppPromoCard />
          </div>
        }
      />
    </div>
  );
}
