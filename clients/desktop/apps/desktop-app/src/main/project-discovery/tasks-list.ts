import {
  incompatibleTaskFilter,
  type ProjectTaskRow,
  type ProjectType,
  type ProjectsListTasksAction,
} from '@canopy/desktop-shared/lib/project-discovery';
import type {
  CoworkWorkEntryData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { COWORK_HOME_WORKTREE_ID } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from './index';
import { DiscoveryError } from './errors';
import { requireAuthorizedProject } from './owner-policy';
import { readProjectEntries, readProjectWorktrees } from './sources';
import { hasRunningChats, readTaskRuntimeSnapshot } from './runtime-state';

export async function listTaskRows(
  action: ProjectsListTasksAction,
  caller: ProjectDiscoveryCaller,
): Promise<{ projectType: ProjectType; items: ProjectTaskRow[] }> {
  const project = await requireAuthorizedProject(action.projectId, caller);
  const projectType: ProjectType = project.type;
  assertSupportedFilters(action, projectType);
  assertProjectAvailable(project.readiness);

  if (projectType === 'cowork') {
    const entries = (await readProjectEntries(project.projectId)).entries;
    const candidates = entries
      .filter((entry) => entry.id !== COWORK_HOME_WORKTREE_ID)
      .map((entry) => ({ entry, row: workEntryBase(project.projectId, entry) }))
      .filter(({ entry, row }) =>
        matchesTaskFilters(action, row, projectType, entry.id),
      );
    const items: ProjectTaskRow[] = [];
    for (const { entry, row } of candidates) {
      const snapshot = await readTaskRuntimeSnapshot(
        project.projectId,
        entry.id,
      );
      const chatIds = chatIdsIn(snapshot.tabsFile.tabs);
      const hasRunning = hasRunningChats(snapshot, chatIds);
      if (
        action.hasRunningChats !== undefined &&
        action.hasRunningChats !== hasRunning
      )
        continue;
      items.push({
        ...row,
        chatCount: chatIds.length,
        hasRunningChats: hasRunning,
      });
    }
    return { projectType, items };
  }

  const worktrees = await readProjectWorktrees(project.projectId);
  const candidates = worktrees
    .filter(isDiscoverableWorktree)
    .map((worktree) => ({
      worktree,
      row: worktreeBase(project.projectId, worktree),
    }))
    .filter(({ worktree, row }) =>
      matchesTaskFilters(action, row, projectType, worktree.branchName),
    );
  const items: ProjectTaskRow[] = [];
  for (const { worktree, row } of candidates) {
    const snapshot = await readTaskRuntimeSnapshot(
      project.projectId,
      worktree.id,
    );
    const chatIds = chatIdsIn(snapshot.tabsFile.tabs);
    const hasRunning = hasRunningChats(snapshot, chatIds);
    if (
      action.hasRunningChats !== undefined &&
      action.hasRunningChats !== hasRunning
    )
      continue;
    items.push({
      ...row,
      chatCount: chatIds.length,
      hasRunningChats: hasRunning,
    });
  }
  return { projectType, items };
}

function assertSupportedFilters(
  action: ProjectsListTasksAction,
  projectType: ProjectType,
): void {
  if (action.retentionStates.includes('archived'))
    throw new DiscoveryError(
      'unsupported_filter',
      'Archived task listing is not supported.',
    );
  const incompatible = incompatibleTaskFilter(action, projectType);
  if (incompatible) throw new DiscoveryError('invalid_payload', incompatible);
}

function assertProjectAvailable(
  readiness: 'ready' | 'pending' | 'unavailable',
): void {
  if (readiness === 'unavailable')
    throw new DiscoveryError(
      'execution_failed',
      'Project inventory could not be read.',
    );
}

function worktreeBase(
  projectId: string,
  worktree: WorktreeData,
): ProjectTaskRow {
  return {
    projectId,
    taskId: worktree.id,
    title: worktree.label ?? worktree.branchName,
    status: worktree.status ?? 'active',
    retentionState: 'retained',
    createdAt: worktree.createdAt,
    ...(worktree.lastTouchedAt
      ? { lastActivityAt: worktree.lastTouchedAt }
      : {}),
    chatCount: 0,
    hasRunningChats: null,
    kind: 'worktree',
    details: {
      kind: 'worktree',
      branchName: worktree.branchName,
      hidden: worktree.hidden ?? false,
      setupPhase: worktree.setupPhase ?? 'git-ready',
      pausedHookKeys: worktree.pausedHookKeys ?? [],
      trackedBaseBranch: worktree.trackedBaseBranch ?? null,
      trackedRepoBaseBranches: worktree.trackedRepoBaseBranches ?? {},
      healthIssue: worktree.healthIssue
        ? {
            code: worktree.healthIssue.code,
            message: worktree.healthIssue.message,
            checkedAt: worktree.healthIssue.checkedAt,
          }
        : null,
    },
  };
}

export function workEntryBase(
  projectId: string,
  entry: CoworkWorkEntryData,
): Extract<ProjectTaskRow, { kind: 'work_entry' }> {
  const title = entry.title ?? entry.summary?.title ?? entry.id;
  const lastActivityAt = entry.lastTouchedAt ?? entry.summary?.lastMessageAt;
  return {
    projectId,
    taskId: entry.id,
    title,
    status: entry.status ?? 'active',
    retentionState: 'retained',
    createdAt: entry.createdAt,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    chatCount: 0,
    hasRunningChats: null,
    kind: 'work_entry',
    details: {
      kind: 'work_entry',
      pinned: entry.pinned ?? false,
      hasUserChanges: entry.hasUserChanges ?? false,
      titleOverride: entry.title ?? null,
      ...(entry.lastTouchedAt ? { lastTouchedAt: entry.lastTouchedAt } : {}),
      ...(entry.summary?.lastMessageAt
        ? { lastMessageAt: entry.summary.lastMessageAt }
        : {}),
      ...(entry.summary?.providerType
        ? { providerType: entry.summary.providerType }
        : {}),
    },
  };
}

export function matchesTaskFilters(
  action: Omit<ProjectsListTasksAction, 'type' | 'projectId'>,
  row: ProjectTaskRow,
  projectType: ProjectType,
  queryTarget: string,
): boolean {
  if (action.statuses && !action.statuses.includes(row.status)) return false;
  if (
    action.name !== undefined &&
    row.title.toLowerCase() !== action.name.toLowerCase()
  )
    return false;
  const query = action.query?.toLowerCase();
  if (
    query !== undefined &&
    ![row.taskId, row.title, queryTarget].some((value) =>
      value.toLowerCase().includes(query),
    )
  )
    return false;
  if (
    action.pinned !== undefined &&
    (projectType !== 'cowork' ||
      row.details.kind !== 'work_entry' ||
      row.details.pinned !== action.pinned)
  )
    return false;
  if (
    action.branchName !== undefined &&
    (projectType !== 'code' ||
      row.details.kind !== 'worktree' ||
      row.details.branchName !== action.branchName)
  )
    return false;
  return true;
}

function chatIdsIn(
  tabs: Array<{ id: string; kind?: 'chat' | 'file' }>,
): string[] {
  return tabs.filter((tab) => tab.kind !== 'file').map((tab) => tab.id);
}

function isDiscoverableWorktree(worktree: WorktreeData): boolean {
  return worktree.hidden !== true && worktree.id !== COWORK_HOME_WORKTREE_ID;
}
