import {
  WORKSPACE_ROOT_REPO_ID,
  type AppAdvisorJson,
  type SidebarItem,
  type WorktreeData,
} from '../types';
import { getWorkspaceDisplayName } from './workspace-display-name';

/**
 * The project and worktree summaries App Advisor's worktree actions answer
 * with, shared by the renderer dispatcher and Electron main (CAN-5997) so a
 * moved action answers exactly as the renderer did. CAN-5998 adds the
 * project settings capabilities its workspace reads answer with.
 */

export function workspaceSummary(item: SidebarItem): AppAdvisorJson {
  const temporary = item.type === 'multi-repo' && item.temporary === true;
  const repos =
    item.type === 'multi-repo'
      ? item.repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          source: repo.source ?? 'local',
          repoPath: repo.repoPath,
          manifestUrl: repo.manifestUrl ?? '',
        }))
      : item.type === 'single-repo'
        ? [
            {
              id: item.id,
              name: item.name,
              source: 'local',
              repoPath: item.repoPath,
              manifestUrl: '',
            },
          ]
        : [];
  return {
    id: item.id,
    name: item.name,
    displayName: getWorkspaceDisplayName(item),
    type: item.type,
    temporary,
    color: item.color,
    collapsed: item.collapsed,
    order: item.order,
    repoPath: item.type === 'single-repo' ? item.repoPath : '',
    sourceRepoPath:
      item.type === 'multi-repo' ? (item.sourceRepoPath ?? '') : '',
    sourceControlledConfigAvailable:
      item.type !== 'multi-repo' ||
      (!temporary && Boolean(item.sourceRepoPath)),
    repoCount:
      item.type === 'multi-repo'
        ? item.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID).length
        : item.type === 'single-repo'
          ? 1
          : 0,
    worktreeCount: item.type === 'cowork' ? 0 : item.worktrees.length,
    repos,
    alwaysShow: item.alwaysShow === true,
    hasDefaultPluginSelections: item.defaultPluginSelections !== undefined,
  };
}

export function worktreeSummary(
  worktree: WorktreeData,
  groupId?: string,
): AppAdvisorJson {
  return {
    id: worktree.id,
    ...(groupId ? { groupId } : {}),
    branchName: worktree.branchName,
    createdAt: worktree.createdAt,
    status: worktree.status ?? 'active',
    hidden: worktree.hidden === true,
    setupPhase: worktree.setupPhase ?? 'git-ready',
    pausedHookKeys: worktree.pausedHookKeys ?? [],
    trackedBaseBranch: worktree.trackedBaseBranch ?? null,
    trackedRepoBaseBranches: worktree.trackedRepoBaseBranches ?? {},
    branchGroupingOverride: worktree.branchGroupingOverride ?? null,
    healthIssue: worktree.healthIssue
      ? {
          code: worktree.healthIssue.code,
          message: worktree.healthIssue.message,
          checkedAt: worktree.healthIssue.checkedAt,
        }
      : null,
  };
}

export function workspaceSettingsCapabilities(
  item: SidebarItem,
): AppAdvisorJson {
  const temporary = item.type === 'multi-repo' && item.temporary === true;
  const sourceControlledEditsAvailable =
    item.type !== 'multi-repo' || (!temporary && Boolean(item.sourceRepoPath));
  const sourceControlledDisabledReason = sourceControlledEditsAvailable
    ? ''
    : temporary
      ? 'Temporary projects are local-only. Promote the project before applying source-controlled changes.'
      : 'This multi-repo project has no attached source repo for source-controlled configuration.';
  return {
    temporary,
    canUpdateLocalOverrides: true,
    canPromoteTemporary: temporary,
    canApplySourceEdits: sourceControlledEditsAvailable,
    sourceControlledEditsAvailable,
    canUseUpdateSourceWorkspaceMode:
      item.type === 'multi-repo' && temporary !== true,
    sourceControlledDisabledReason,
  };
}
