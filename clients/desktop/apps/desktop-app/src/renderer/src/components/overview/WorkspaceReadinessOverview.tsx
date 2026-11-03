import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  SidebarItem,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { OverviewSectionHeader } from '@canopy/ui-app';
import { Button, LoadingSpinner } from '@/components/shared';
import { RefreshSpinner } from '@/components/shared/loading/spinners/RefreshSpinner';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useWorkspaceReadinessLaunchReconciliation,
  useWorkspaceReadinessMissingChats,
} from '@/hooks/useWorkspaceReadinessLaunchReconciliation';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
} from '@/lib/workspaceReadinessLauncher';
import {
  launchedReadinessFixesForTarget,
  launchedReadinessFixKey,
} from '@/lib/workspaceReadinessLaunches';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  pruneResolvedWorkspaceReadinessLaunches,
  selectWorkspaceReadinessLaunch,
  snapshotWorkspaceReadinessLaunches,
  useWorkspaceReadinessLaunchStore,
} from '@/stores/workspaceReadinessLaunchStore';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ErrorBanner, StatusLabel } from '@canopy/ui-shared/components';

const READINESS_PARALLELISM = 4;

type CodeWorkspace = Exclude<SidebarItem, { type: 'cowork' }>;

interface WorkspaceReadinessOverviewProps {
  projects: SidebarItem[];
  hasHydratedProjects: boolean;
}

interface WorkspaceReadinessResult {
  workspaceId: string;
  issues?: WorkspaceReadinessIssue[];
  complete?: boolean;
  failed?: true;
}

async function readWithConcurrency(
  workspaces: CodeWorkspace[],
): Promise<WorkspaceReadinessResult[]> {
  const results: WorkspaceReadinessResult[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(READINESS_PARALLELISM, workspaces.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < workspaces.length) {
        const workspace = workspaces[nextIndex];
        nextIndex += 1;
        try {
          const response = await window.api.getWorkspaceReadiness({
            workspaceId: workspace.id,
          });
          results.push({
            workspaceId: workspace.id,
            issues: response.issues,
            complete: response.complete,
          });
        } catch {
          results.push({ workspaceId: workspace.id, failed: true });
        }
      }
    }),
  );
  return results;
}

function membershipKey(workspaces: CodeWorkspace[]): string {
  return workspaces
    .map((workspace) => {
      if (workspace.type === 'single-repo') {
        return `${workspace.id}:single:${workspace.repoPath}`;
      }
      const repos = workspace.repos
        .map((repo) => `${repo.id}:${repo.repoPath}`)
        .sort()
        .join(',');
      return `${workspace.id}:multi:${repos}`;
    })
    .sort()
    .join('|');
}

interface WorkspaceCellProps {
  workspaceName: string;
  rowSpan?: number;
}

function WorkspaceCell({
  workspaceName,
  rowSpan,
}: WorkspaceCellProps): JSX.Element {
  return (
    <th
      rowSpan={rowSpan}
      className="px-3 py-2.5 text-left font-normal align-top"
    >
      <div
        className={`${POSTHOG_REPLAY_MASK_CLASS} truncate text-xs font-medium fg-primary`}
        title={workspaceName}
      >
        {workspaceName}
      </div>
    </th>
  );
}

interface WorkspaceSettingsButtonProps {
  workspaceId: string;
  workspaceName: string;
}

function WorkspaceSettingsButton({
  workspaceId,
  workspaceName,
}: WorkspaceSettingsButtonProps): JSX.Element {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Open settings for ${workspaceName}`}
      onClick={() =>
        useNavigationStore.getState().openWorkspaceSettings({
          workspaceId,
          initialTab: 'details',
        })
      }
    >
      Open settings
    </Button>
  );
}

export function WorkspaceReadinessOverview({
  projects,
  hasHydratedProjects,
}: WorkspaceReadinessOverviewProps): JSX.Element | null {
  const codeWorkspaces = useMemo(
    () =>
      projects.filter(
        (project): project is CodeWorkspace => project.type !== 'cowork',
      ),
    [projects],
  );
  const codeMembershipKey = membershipKey(codeWorkspaces);
  const currentWorkspacesRef = useRef(codeWorkspaces);
  currentWorkspacesRef.current = codeWorkspaces;

  const [issuesByWorkspace, setIssuesByWorkspace] = useState<
    Record<string, WorkspaceReadinessIssue[]>
  >({});
  const [failedWorkspaceIds, setFailedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [refreshing, setRefreshing] = useState(codeWorkspaces.length > 0);
  const refreshingRef = useRef(codeWorkspaces.length > 0);
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const retryingWorkspaceIdsRef = useRef(new Set<string>());
  const [retryingWorkspaceIds, setRetryingWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [launchError, setLaunchError] = useState<string | null>(null);
  /**
   * Launched readiness fixes, shared with Home and workspace settings and
   * persisted across restarts. The Overview audits each reference checkout,
   * so only reference-target launches apply here.
   */
  const launchRecords = useWorkspaceReadinessLaunchStore(
    (state) => state.records,
  );
  const missingChats = useWorkspaceReadinessMissingChats(launchRecords);
  useWorkspaceReadinessLaunchReconciliation();
  const generationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const workspaces = currentWorkspacesRef.current;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const launchSnapshots = new Map(
      workspaces.map((workspace) => [
        workspace.id,
        snapshotWorkspaceReadinessLaunches(workspace.id, undefined),
      ]),
    );
    const activeIds = new Set(workspaces.map((workspace) => workspace.id));
    setIssuesByWorkspace((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([workspaceId]) =>
          activeIds.has(workspaceId),
        ),
      ),
    );
    setFailedWorkspaceIds(
      (current) =>
        new Set(Array.from(current).filter((id) => activeIds.has(id))),
    );
    refreshingRef.current = workspaces.length > 0;
    setRefreshing(workspaces.length > 0);

    const results = await readWithConcurrency(workspaces);
    if (generationRef.current !== generation) return;
    for (const result of results) {
      if (result.issues) {
        pruneResolvedWorkspaceReadinessLaunches(
          launchSnapshots.get(result.workspaceId) ?? [],
          result.issues,
          result.complete,
        );
      }
    }

    setIssuesByWorkspace((current) => {
      const next = { ...current };
      for (const workspaceId of Array.from(activeIds)) {
        delete next[workspaceId];
      }
      for (const result of results) {
        if (result.issues) next[result.workspaceId] = result.issues;
      }
      return next;
    });
    setFailedWorkspaceIds(
      new Set(
        results
          .filter((result) => result.failed)
          .map((result) => result.workspaceId),
      ),
    );
    refreshingRef.current = false;
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (hasHydratedProjects) {
      void refresh();
    }
    return (): void => {
      generationRef.current += 1;
    };
  }, [codeMembershipKey, hasHydratedProjects, refresh]);

  const retry = async (workspace: CodeWorkspace): Promise<void> => {
    if (
      refreshingRef.current ||
      retryingWorkspaceIdsRef.current.has(workspace.id)
    ) {
      return;
    }
    retryingWorkspaceIdsRef.current.add(workspace.id);
    setRetryingWorkspaceIds((current) => new Set(current).add(workspace.id));
    const generation = generationRef.current;
    const launchSnapshot = snapshotWorkspaceReadinessLaunches(
      workspace.id,
      undefined,
    );
    try {
      const response = await window.api.getWorkspaceReadiness({
        workspaceId: workspace.id,
      });
      if (
        generationRef.current !== generation ||
        !currentWorkspacesRef.current.some(
          (current) => current.id === workspace.id,
        )
      ) {
        return;
      }
      pruneResolvedWorkspaceReadinessLaunches(
        launchSnapshot,
        response.issues,
        response.complete,
      );
      setIssuesByWorkspace((current) => ({
        ...current,
        [workspace.id]: response.issues,
      }));
      setFailedWorkspaceIds((current) => {
        const next = new Set(current);
        next.delete(workspace.id);
        return next;
      });
    } catch {
      if (
        generationRef.current !== generation ||
        !currentWorkspacesRef.current.some(
          (current) => current.id === workspace.id,
        )
      ) {
        return;
      }
      setIssuesByWorkspace((current) => {
        const next = { ...current };
        delete next[workspace.id];
        return next;
      });
      setFailedWorkspaceIds((current) => new Set(current).add(workspace.id));
    } finally {
      retryingWorkspaceIdsRef.current.delete(workspace.id);
      setRetryingWorkspaceIds((current) => {
        const next = new Set(current);
        next.delete(workspace.id);
        return next;
      });
    }
  };

  const handleFix = async (
    workspaceId: string,
    issue: WorkspaceReadinessIssue,
  ): Promise<void> => {
    if (launchingKey !== null) return;
    const key = `${workspaceId}:${workspaceReadinessIssueKey(issue)}`;
    setLaunchingKey(key);
    setLaunchError(null);
    // The Overview stays put so the user can fire several recommendations in a
    // row; the launch record turns the row into "View conversation".
    const result = await launchWorkspaceReadinessFix(
      workspaceId,
      issue,
      undefined,
      { navigateToChat: false },
    );
    if (!result.ok) {
      setLaunchError(result.message);
    }
    setLaunchingKey(null);
  };

  const hasAnyResult = Object.keys(issuesByWorkspace).length > 0;
  const totalIssueCount = Object.values(issuesByWorkspace).reduce(
    (total, issues) => total + issues.length,
    0,
  );
  const allLoaded =
    Object.keys(issuesByWorkspace).length + failedWorkspaceIds.size ===
    codeWorkspaces.length;
  const waitingForWorkspaceInventory = !hasHydratedProjects;
  const showingInitialCheck =
    waitingForWorkspaceInventory ||
    (codeWorkspaces.length > 0 &&
      !hasAnyResult &&
      failedWorkspaceIds.size === 0 &&
      (refreshing || !allLoaded));

  useCurrentUiStateReporter('workspaceReadiness.overview', {
    surface: 'overview',
    status: showingInitialCheck
      ? 'loading'
      : failedWorkspaceIds.size > 0
        ? 'error'
        : 'ready',
    issueCount: totalIssueCount,
    failedWorkspaceCount: failedWorkspaceIds.size,
    launching: launchingKey !== null,
    launchedChatCount: codeWorkspaces.reduce(
      (total, workspace) =>
        total +
        launchedReadinessFixesForTarget(launchRecords, workspace.id, undefined)
          .length,
      0,
    ),
    errorVisible: launchError !== null,
  });

  if (codeWorkspaces.length === 0 && !waitingForWorkspaceInventory) {
    return null;
  }

  return (
    <section className="min-w-0" data-testid="workspace-readiness-overview">
      <OverviewSectionHeader
        title="Project readiness"
        count={totalIssueCount}
        countLabel={`${totalIssueCount} recommendations`}
        actions={
          /*
           * Refresh progress lives inside the button rather than in a row
           * above the list. RefreshSpinner keeps a constant footprint and
           * avoids shifting the recommendations on every refresh.
           */
          !waitingForWorkspaceInventory ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <span className="flex items-center gap-1.5">
                <RefreshSpinner spinning={refreshing} />
                Refresh
              </span>
            </Button>
          ) : undefined
        }
      />

      <p className="mb-2 text-xs fg-secondary">
        Suggestions for deeper repository integration.
      </p>

      <div className="overflow-hidden rounded-lg border bg-secondary/10">
        <div
          className="max-h-96 overflow-y-auto"
          data-testid="workspace-readiness-table-scroll"
        >
          <table
            aria-label="Project readiness recommendations"
            className="w-full table-fixed text-left"
          >
            <thead className="sticky top-0 z-10 bg-base">
              <tr>
                <th
                  scope="col"
                  className="w-9/25 border-b px-3 py-2 text-3xs font-medium fg-secondary"
                >
                  Project
                </th>
                <th
                  scope="col"
                  className="border-b px-3 py-2 text-3xs font-medium fg-secondary"
                >
                  Recommendation
                </th>
              </tr>
            </thead>
            <tbody>
              {showingInitialCheck && (
                <tr>
                  <td colSpan={2} className="px-3 py-5">
                    <div className="flex items-center gap-2 text-xs fg-secondary">
                      <LoadingSpinner />
                      <span>Checking project readiness…</span>
                    </div>
                  </td>
                </tr>
              )}

              {!showingInitialCheck &&
                allLoaded &&
                failedWorkspaceIds.size === 0 &&
                totalIssueCount === 0 && (
                  <tr>
                    <td colSpan={2} className="px-3 py-5 text-xs fg-secondary">
                      All Code projects have setup and launch scripts, hooks,
                      and shared agent instructions in place.
                    </td>
                  </tr>
                )}

              {codeWorkspaces.map((workspace) => {
                const issues = issuesByWorkspace[workspace.id] ?? [];
                const failed = failedWorkspaceIds.has(workspace.id);
                if (!failed && issues.length === 0) return null;
                const workspaceName = getWorkspaceDisplayName(workspace);

                if (failed) {
                  return (
                    <tr
                      key={workspace.id}
                      className="border-t first:border-t-0"
                    >
                      <WorkspaceCell workspaceName={workspaceName} />
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs">
                            <StatusLabel>
                              Couldn’t check{' '}
                              <span className={POSTHOG_REPLAY_MASK_CLASS}>
                                {workspaceName}
                              </span>
                              .
                            </StatusLabel>
                          </p>
                          <div className="flex flex-wrap items-center gap-1">
                            <WorkspaceSettingsButton
                              workspaceId={workspace.id}
                              workspaceName={workspaceName}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={
                                retryingWorkspaceIds.has(workspace.id)
                                  ? `Trying again for ${workspaceName}`
                                  : `Try again for ${workspaceName}`
                              }
                              aria-busy={retryingWorkspaceIds.has(workspace.id)}
                              disabled={
                                refreshing ||
                                retryingWorkspaceIds.has(workspace.id)
                              }
                              onClick={() => void retry(workspace)}
                            >
                              {retryingWorkspaceIds.has(workspace.id)
                                ? 'Trying again…'
                                : 'Try again'}
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                const rowCount = issues.length;
                return issues.map((issue, issueIndex) => {
                  const key = `${workspace.id}:${workspaceReadinessIssueKey(issue)}`;
                  const isLaunching = launchingKey === key;
                  const launched = selectWorkspaceReadinessLaunch(
                    { records: launchRecords },
                    workspace.id,
                    undefined,
                    workspaceReadinessIssueKey(issue),
                  );
                  const chatMissing =
                    launched !== undefined &&
                    missingChats.includes(launchedReadinessFixKey(launched));
                  const viewLabel = chatMissing
                    ? 'Open worktree'
                    : 'View conversation';
                  return (
                    <tr key={key} className="border-t first:border-t-0">
                      {issueIndex === 0 && (
                        <WorkspaceCell
                          workspaceName={workspaceName}
                          rowSpan={rowCount}
                        />
                      )}
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs fg-primary">
                              {issue.title}
                            </div>
                            <div className="truncate text-3xs fg-secondary">
                              {issue.code === 'recovery-required'
                                ? issue.message
                                : issue.repoName}
                            </div>
                            {chatMissing && (
                              <div className="text-3xs fg-secondary">
                                Conversation unavailable
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {issueIndex === 0 && (
                              <WorkspaceSettingsButton
                                workspaceId={workspace.id}
                                workspaceName={workspaceName}
                              />
                            )}
                            {issue.fixPrompt === null ? null : launched ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`${viewLabel} for ${issue.title} in ${workspaceName}`}
                                onClick={() =>
                                  void navigateToWorkspaceReadinessChat(
                                    workspace.id,
                                    launched.worktreeId,
                                    launched.chatId,
                                  )
                                }
                              >
                                {viewLabel}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={
                                  isLaunching
                                    ? `Starting fix for ${issue.title} in ${workspaceName}`
                                    : `Fix ${issue.title} in new worktree for ${workspaceName}`
                                }
                                aria-busy={isLaunching}
                                disabled={launchingKey !== null}
                                onClick={() =>
                                  void handleFix(workspace.id, issue)
                                }
                              >
                                {isLaunching
                                  ? 'Starting…'
                                  : 'Fix in new worktree'}
                              </Button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ErrorBanner error={launchError} className="mt-3" />
    </section>
  );
}
