import {
  blocksClose as selectBlocksClose,
  hasBackgroundWork as selectHasBackgroundWork,
  backgroundTaskCount,
} from '@canopy/desktop-shared/lib/background-work';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import {
  BACKGROUND_WORK_CHAT_REFUSAL,
  BACKGROUND_WORK_REMOVAL_REFUSAL,
  LIVE_DELEGATES_CHAT_REFUSAL,
  LIVE_DELEGATES_REMOVAL_REFUSAL,
  LiveDelegationsError,
  activeDelegationCount,
  chatHasLiveDelegations,
  listDelegationActivity,
  parseDelegationSessionKey,
  queuedDelegationCount,
  subscribeDelegationActivity,
  workspaceHasLiveDelegations,
  worktreeHasLiveDelegations,
} from './delegation/activity';
import { buildChatSessionKey } from './session-key';
import {
  getLiveBackgroundTasksForChat,
  listLiveBackgroundTaskOwners,
  subscribeLiveBackgroundTasks,
} from './session-manager';

interface BackgroundWorkTargetScope {
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  liveTasks: ActivityLiveBgTask[];
}

function getDelegationCounts(sessionKey: string): {
  live: number;
  queued: number;
} {
  return {
    live: activeDelegationCount(sessionKey),
    queued: queuedDelegationCount(sessionKey),
  };
}

function getChatBackgroundWork(
  projectId: string,
  worktreeId: string,
  chatId: string,
): { hasBackgroundWork: boolean; blocksClose: boolean } {
  const sessionKey = buildChatSessionKey(projectId, worktreeId, chatId);
  const delegations = getDelegationCounts(sessionKey);
  const liveTasks =
    getLiveBackgroundTasksForChat(projectId, worktreeId, chatId) ?? [];
  return {
    hasBackgroundWork: selectHasBackgroundWork(delegations, liveTasks),
    blocksClose: selectBlocksClose(delegations, liveTasks),
  };
}

/** Whether the chat has any live provider task or delegation activity. */
export function chatHasBackgroundWork(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return getChatBackgroundWork(projectId, worktreeId, chatId).hasBackgroundWork;
}

/** Whether closing the chat would interrupt work that must remain live. */
export function chatBlocksClose(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return getChatBackgroundWork(projectId, worktreeId, chatId).blocksClose;
}

function scopeHasBackgroundWork(
  prefix: string,
  blockingOnly: boolean,
): boolean {
  return listBackgroundWorkTargets().some(
    (target) =>
      target.sessionKey.startsWith(prefix) &&
      (blockingOnly ? target.blocksClose : target.hasBackgroundWork),
  );
}

/** Whether any chat in this worktree has live background work. */
export function worktreeHasBackgroundWork(
  projectId: string,
  worktreeId: string,
): boolean {
  return scopeHasBackgroundWork(`${projectId}/${worktreeId}/`, false);
}

/** Whether any chat in this worktree blocks close. */
export function worktreeBlocksClose(
  projectId: string,
  worktreeId: string,
): boolean {
  return scopeHasBackgroundWork(`${projectId}/${worktreeId}/`, true);
}

/** Whether any chat in this workspace has live background work. */
export function workspaceHasBackgroundWork(projectId: string): boolean {
  return scopeHasBackgroundWork(`${projectId}/`, false);
}

/** Whether any chat in this workspace blocks close. */
export function workspaceBlocksClose(projectId: string): boolean {
  return scopeHasBackgroundWork(`${projectId}/`, true);
}

/** Why a chat cannot close: its delegates first, then provider agents or workflows. */
export type CloseBlockReason = 'delegates' | 'background';

/** The reason a chat cannot close, or null; delegates keep priority and their copy. */
export function chatCloseBlockReason(
  projectId: string,
  worktreeId: string,
  chatId: string,
): CloseBlockReason | null {
  if (chatHasLiveDelegations(projectId, worktreeId, chatId)) return 'delegates';
  return chatBlocksClose(projectId, worktreeId, chatId) ? 'background' : null;
}

/** Refuses closing or archiving a chat while close-blocking work is live. */
export function assertChatCanClose(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const reason = chatCloseBlockReason(projectId, worktreeId, chatId);
  if (reason === 'delegates')
    throw new LiveDelegationsError(LIVE_DELEGATES_CHAT_REFUSAL);
  if (reason === 'background')
    throw new LiveDelegationsError(BACKGROUND_WORK_CHAT_REFUSAL);
}

/** Refuses removing a worktree or Work Entry while close-blocking work is live. */
export function assertWorktreeCanBeRemoved(
  projectId: string,
  worktreeId: string,
): void {
  if (worktreeHasLiveDelegations(projectId, worktreeId))
    throw new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL);
  if (worktreeBlocksClose(projectId, worktreeId))
    throw new LiveDelegationsError(BACKGROUND_WORK_REMOVAL_REFUSAL);
}

/** Refuses removing a workspace or project while close-blocking work is live. */
export function assertWorkspaceCanBeRemoved(projectId: string): void {
  if (workspaceHasLiveDelegations(projectId))
    throw new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL);
  if (workspaceBlocksClose(projectId))
    throw new LiveDelegationsError(BACKGROUND_WORK_REMOVAL_REFUSAL);
}

/** Current background-work answer for each live-task or delegation owner. */
export function listBackgroundWorkTargets(): Array<{
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  hasBackgroundWork: boolean;
  blocksClose: boolean;
  /** D11's count for the chat: its delegations and live provider tasks. */
  backgroundTasks: number;
}> {
  const targets = new Map<string, BackgroundWorkTargetScope>();

  for (const owner of listLiveBackgroundTaskOwners()) {
    targets.set(owner.sessionKey, {
      ...owner,
      liveTasks: owner.liveTasks,
    });
  }

  for (const entry of listDelegationActivity()) {
    if (targets.has(entry.sessionKey)) continue;
    const target = parseDelegationSessionKey(entry.sessionKey);
    if (!target) continue;
    targets.set(entry.sessionKey, {
      sessionKey: entry.sessionKey,
      ...target,
      liveTasks:
        getLiveBackgroundTasksForChat(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ) ?? [],
    });
  }

  return Array.from(targets.values(), (target) => {
    const delegations = getDelegationCounts(target.sessionKey);
    return {
      sessionKey: target.sessionKey,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      hasBackgroundWork: selectHasBackgroundWork(delegations, target.liveTasks),
      blocksClose: selectBlocksClose(delegations, target.liveTasks),
      backgroundTasks: backgroundTaskCount(delegations, target.liveTasks),
    };
  });
}

/** Observe task and delegation changes for one or more session keys. */
export function subscribeBackgroundWork(
  listener: (sessionKey: string) => void,
): () => void {
  const unsubscribeLiveTasks = subscribeLiveBackgroundTasks(listener);
  const unsubscribeDelegations = subscribeDelegationActivity((entry) => {
    listener(entry.sessionKey);
  });
  return (): void => {
    unsubscribeLiveTasks();
    unsubscribeDelegations();
  };
}
