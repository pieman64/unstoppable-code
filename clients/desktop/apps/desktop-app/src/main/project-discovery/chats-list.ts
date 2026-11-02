import type {
  ProjectChatRow,
  ProjectType,
  ProjectsListTaskChatsAction,
} from '@canopy/desktop-shared/lib/project-discovery';
import type {
  ChatStateSnapshot,
  CoworkWorkEntryData,
  PersistedChatTab,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { COWORK_HOME_WORKTREE_ID } from '@canopy/desktop-shared/types';
import type { BotChatRow } from '@canopy/desktop-shared/lib/bot-discovery';
import type { ProjectDiscoveryCaller } from './index';
import { DiscoveryError } from './errors';
import { requireAuthorizedProject } from './owner-policy';
import { readProjectEntries, readProjectWorktrees } from './sources';
import {
  projectRuntimeEvidence,
  readTaskRuntimeSnapshot,
} from './runtime-state';

export async function listChatRows(
  action: ProjectsListTaskChatsAction,
  caller: ProjectDiscoveryCaller,
): Promise<ProjectChatRow[]> {
  const project = await requireAuthorizedProject(action.projectId, caller);
  const projectType: ProjectType = project.type;
  assertSupportedFilters(action);
  if (project.readiness === 'unavailable')
    throw new DiscoveryError(
      'execution_failed',
      'Project inventory could not be read.',
    );

  const taskIds = await listDiscoverableTaskIds(project.projectId, projectType);
  const selectedTaskIds = action.taskId
    ? taskIds.filter((taskId) => taskId === action.taskId)
    : taskIds;
  if (action.taskId && selectedTaskIds.length === 0)
    throw new DiscoveryError('not_found', 'Task was not found.');
  const rows: ProjectChatRow[] = [];

  for (const taskId of selectedTaskIds) {
    const snapshot = await readTaskRuntimeSnapshot(project.projectId, taskId);
    for (const tab of snapshot.tabsFile.tabs) {
      if (tab.kind === 'file') continue;
      const row = projectChatRow(project.projectId, taskId, tab, snapshot);
      if (matchesChatFilters(action, row)) rows.push(row);
    }
  }

  return rows;
}

function assertSupportedFilters(action: ProjectsListTaskChatsAction): void {
  if (action.retentionStates.includes('archived'))
    throw new DiscoveryError(
      'unsupported_filter',
      'Archived chat listing is not supported.',
    );
}

/** The discoverable tasks of an authorized project (no home or hidden rows). */
export async function listDiscoverableTaskIds(
  projectId: string,
  projectType: ProjectType,
): Promise<string[]> {
  return projectType === 'cowork'
    ? (await readProjectEntries(projectId)).entries
        .filter(isDiscoverableWorkEntry)
        .map((entry) => entry.id)
    : (await readProjectWorktrees(projectId))
        .filter(isDiscoverableWorktree)
        .map((worktree) => worktree.id);
}

/** The public row for one chat tab in a task snapshot. */
export function projectChatRow(
  projectId: string,
  taskId: string,
  tab: PersistedChatTab,
  snapshot: ChatStateSnapshot,
): ProjectChatRow {
  const runtime = projectRuntimeEvidence(snapshot, tab.id);
  const expired = tab.staleSessionDetected !== undefined;
  const readOnly = tab.readOnly === true || expired;
  const canSteerQueuedMessage =
    runtime.queuedMessageCount > 0 && runtime.canSteerQueuedMessage;
  const droppedText = tab.staleSessionDetected?.droppedMessageText ?? '';
  const droppedFileReferenceCount =
    tab.staleSessionDetected?.droppedFileReferences?.length ?? 0;
  return {
    projectId,
    taskId,
    chatId: tab.id,
    title: tab.customTitle ?? tab.title,
    ...(tab.description ? { description: tab.description } : {}),
    ...(tab.createdAt ? { createdAt: tab.createdAt } : {}),
    ...(runtime.lastActivityAt
      ? { lastActivityAt: runtime.lastActivityAt }
      : {}),
    retentionState: 'retained',
    runtimeState: runtime.runtimeState,
    runtimeObservedAt: runtime.runtimeObservedAt,
    queuedMessageCount: runtime.queuedMessageCount,
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.executionHarness ? { executionHarness: tab.executionHarness } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.pluginSelections
      ? {
          hasPluginSelections:
            tab.pluginSelections.collectionIds.length > 0 ||
            tab.pluginSelections.skillRefs.length > 0 ||
            tab.pluginSelections.pluginRefs.length > 0 ||
            (tab.pluginSelections.mcpServerRefs?.length ?? 0) > 0,
        }
      : {}),
    session: {
      state: expired
        ? 'expired'
        : runtime.runtimeState === 'error'
          ? 'error'
          : runtime.runtimeState === 'running' ||
              runtime.runtimeState === 'queued'
            ? 'active'
            : 'idle',
      expired,
      readOnly,
      // The hand-off action accepts expired sessions, as the dispatcher reports.
      canHandOff: expired,
      undeliveredMessagePresent:
        droppedText.length > 0 || droppedFileReferenceCount > 0,
      undeliveredMessageLength: droppedText.length,
      undeliveredFileReferenceCount: droppedFileReferenceCount,
      ...(tab.staleSessionDetected?.droppedInputMode
        ? { undeliveredInputMode: tab.staleSessionDetected.droppedInputMode }
        : {}),
    },
    capabilities: {
      canRead: true,
      canSend: !readOnly,
      canWatch: true,
      canSteerQueuedMessage,
      ...(!canSteerQueuedMessage
        ? {
            unavailableReason:
              runtime.queuedMessageCount === 0
                ? 'no_queued_message'
                : 'steering_capability_unavailable',
          }
        : {}),
    },
  };
}

export function matchesChatFilters(
  action: Omit<ProjectsListTaskChatsAction, 'type' | 'projectId'>,
  row: ProjectChatRow | BotChatRow,
): boolean {
  if (
    action.query !== undefined &&
    ![
      'projectId' in row ? row.projectId : row.botId,
      row.taskId,
      row.chatId,
      row.title,
      row.description,
      row.providerType,
      row.model,
      row.executionHarness,
    ].some((value) =>
      value?.toLowerCase().includes(action.query?.toLowerCase() ?? ''),
    )
  )
    return false;
  if (
    action.name !== undefined &&
    row.title.toLowerCase() !== action.name.toLowerCase()
  )
    return false;
  if (action.runtimeStates && !action.runtimeStates.includes(row.runtimeState))
    return false;
  if (
    action.providerTypes &&
    (!row.providerType || !action.providerTypes.includes(row.providerType))
  )
    return false;
  if (
    action.executionHarnesses &&
    (!row.executionHarness ||
      !action.executionHarnesses.includes(row.executionHarness))
  )
    return false;
  if (action.hasQueuedMessages !== undefined) {
    const hasQueuedMessages =
      row.queuedMessageCount === null ? null : row.queuedMessageCount > 0;
    if (
      hasQueuedMessages === null ||
      hasQueuedMessages !== action.hasQueuedMessages
    )
      return false;
  }
  return true;
}

export function isDiscoverableWorktree(worktree: WorktreeData): boolean {
  return worktree.hidden !== true && worktree.id !== COWORK_HOME_WORKTREE_ID;
}

export function isDiscoverableWorkEntry(entry: CoworkWorkEntryData): boolean {
  return entry.id !== COWORK_HOME_WORKTREE_ID;
}
