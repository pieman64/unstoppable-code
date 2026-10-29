import { projectSidebarItemGroups } from './sidebar-item-groups-service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { getOrgProjectCatalogService } from './org-project-catalog-service';
import { appendOrgProjectPlaceholderRows } from './org-project-placeholder-rows';
import type { DesktopSessionSnapshotArgs } from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { listWorktreeChatSummaryBatch } from './worktree-chat-summary-batch';
import type {
  PortalSessionShellState,
  PortalTarget,
} from '@canopy/protocol/portal';
import { listWorkspacePortalEntities } from './workspace-portal-service';
import {
  listStandaloneChats,
  projectStandaloneChatSnapshot,
} from './standalone-chat-service';

/** Placeholders belong to the unscoped overview only; a scoped snapshot names real rows. */
function isOverviewTarget(target: PortalTarget | undefined): boolean {
  return (
    target === undefined ||
    Object.values(target).every((value) => value === undefined)
  );
}

function isActivityId(value: string): boolean {
  try {
    validateId(value, 'activityId');
    return true;
  } catch {
    return false;
  }
}

export async function buildDesktopSessionSnapshot(
  args?: DesktopSessionSnapshotArgs,
): Promise<PortalSessionShellState> {
  const { includeChatSummaries, ...scope } = args ?? {};
  const target = args === undefined ? undefined : scope;
  const workspaces: PortalSessionShellState['workspaces'] = [];
  const worktrees: PortalSessionShellState['worktrees'] = [];
  await listWorkspacePortalEntities(target, {
    statsSource: 'desktop-session-snapshot',
    onWorkspace: (workspace): void => {
      workspaces.push(workspace);
    },
    onWorktree: (worktree): void => {
      worktrees.push(worktree);
    },
  });
  const context = getWorkspaceContextService().getState().context;
  let snapshotWorkspaces = workspaces;
  if (
    isOverviewTarget(target) &&
    context.kind === 'organization' &&
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
  ) {
    // `peek` and not `list`: `list` refreshes a stale entry and clears an
    // unavailable one, and both broadcast — which invalidates this snapshot,
    // which rebuilds it, which reads the catalog again. Reading the cache
    // keeps the catalog's own refresh schedule the only thing that fetches,
    // and the broadcast still invalidates this snapshot once, when the rows
    // actually change.
    try {
      const catalog = getOrgProjectCatalogService().peek(context);
      if (catalog)
        snapshotWorkspaces = appendOrgProjectPlaceholderRows(
          workspaces,
          catalog,
          context,
        );
    } catch {
      // Catalog availability must never prevent local session discovery.
    }
  }
  let standaloneChats =
    target?.workspaceLocalId ||
    (includeChatSummaries === true && !isOverviewTarget(target))
      ? []
      : (
          await listStandaloneChats(
            includeChatSummaries === true
              ? {
                  strict: true,
                  projectIds: workspaces
                    .filter(
                      (workspace) =>
                        !workspace.hidden &&
                        workspace.type === 'cowork' &&
                        isActivityId(workspace.localId),
                    )
                    .map((workspace) => workspace.localId),
                }
              : undefined,
          )
        ).map(projectStandaloneChatSnapshot);

  let chatSummaries: PortalSessionShellState['chatSummaries'] = [];
  if (includeChatSummaries === true) {
    const visibleWorkspaces = new Map(
      workspaces
        .filter((workspace) => !workspace.hidden)
        .map((workspace) => [workspace.localId, workspace]),
    );
    const targets = worktrees
      .filter((worktree) => {
        const parent = visibleWorkspaces.get(worktree.workspaceLocalId);
        if (
          !parent ||
          worktree.hidden ||
          (parent.type !== 'single-repo' && parent.type !== 'multi-repo')
        )
          return false;
        if (
          target?.workspaceLocalId &&
          parent.localId !== target.workspaceLocalId
        )
          return false;
        if (
          target?.worktreeLocalId &&
          worktree.localId !== target.worktreeLocalId
        )
          return false;
        try {
          validateId(parent.localId, 'workspaceId');
          validateId(worktree.localId, 'worktreeId');
          return true;
        } catch {
          return false;
        }
      })
      .map((worktree) => ({
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
      }));
    chatSummaries = (await listWorktreeChatSummaryBatch(targets)).flatMap(
      ({ target: pair, summaries }) =>
        summaries.filter(
          (summary) =>
            summary.scope === 'worktree' &&
            isActivityId(summary.chatId) &&
            summary.workspaceLocalId === pair.workspaceLocalId &&
            summary.worktreeLocalId === pair.worktreeLocalId,
        ),
    );
    standaloneChats = standaloneChats.filter((chat) => {
      if (!isOverviewTarget(target)) return false;
      const parent = visibleWorkspaces.get(chat.projectLocalId);
      return (
        parent?.type === 'cowork' &&
        !chat.archived &&
        isActivityId(chat.localId) &&
        (chat.workEntryId === undefined || isActivityId(chat.workEntryId))
      );
    });
  }

  const appAdvisorItemGroups = await projectSidebarItemGroups({
    appAdvisor: true,
  });
  return {
    ...(appAdvisorItemGroups === undefined ? {} : { appAdvisorItemGroups }),
    workspaces: snapshotWorkspaces,
    worktrees,
    chatProjects: [],
    standaloneChats,
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries,
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}
