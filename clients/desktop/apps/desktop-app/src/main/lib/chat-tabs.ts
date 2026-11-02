import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { resolveChatTabsFilePath } from './resolve-worktree';
import {
  writeBufferFully,
  writeJsonValuesCooperatively,
} from './cooperative-json';

export type ChatTabsWriteObserver = (
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
  delta: ChatTabsWriteDelta | undefined,
  revision: number,
  isCurrent?: () => boolean,
) => void | Promise<void>;

export interface ChatTabsWriteDelta {
  changedTabIds: readonly string[];
  removedTabIds: readonly string[];
  /** Allows explicit rollback/import recovery to resurrect tombstoned ids. */
  authoritative?: boolean;
}

let chatTabsWriteObserver: ChatTabsWriteObserver | null = null;
let chatTabsRequiredDurabilityObserver: ChatTabsWriteObserver | null = null;

export function setChatTabsWriteObserver(
  observer: ChatTabsWriteObserver | null,
): void {
  chatTabsWriteObserver = observer;
}

export function setChatTabsRequiredDurabilityObserver(
  observer: ChatTabsWriteObserver | null,
): void {
  chatTabsRequiredDurabilityObserver = observer;
}

export async function ensureChatTabsRequiredDurability(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
  delta: ChatTabsWriteDelta | undefined,
  revision: number,
): Promise<void> {
  await chatTabsRequiredDurabilityObserver?.(
    projectId,
    worktreeId,
    data,
    delta,
    revision,
  );
}

export const chatTabsTestExports = { writeBufferFully };

/**
 * Preserve the existing pretty-printed JSON format while yielding after
 * bounded chunks. `JSON.stringify()` runs to completion synchronously, which
 * can block Electron main for hundreds of milliseconds on large transcripts.
 */
export async function writePrettyJsonCooperatively(
  filePath: string,
  value: unknown,
  shouldAbort?: () => boolean,
): Promise<void> {
  await writeJsonValuesCooperatively(filePath, [value], {
    pretty: true,
    shouldAbort,
  });
}

/**
 * Publish an already-durable canonical materialization to derived indexes and
 * compatibility caches. This performs no persistence and is safe to invoke
 * only after the repository has fsynced its journal record.
 */
export async function notifyChatTabsMaterialized(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
  delta?: ChatTabsWriteDelta,
  revision = data.revision ?? 0,
  isCurrent?: () => boolean,
): Promise<void> {
  const observer = chatTabsWriteObserver;
  if (!observer) return;
  await observer(projectId, worktreeId, data, delta, revision, isCurrent);
  if (isCurrent?.() === false) return;
  void import('../shared-containers/publish/scheduler')
    .then(({ getSharedContainerPublishScheduler }) =>
      getSharedContainerPublishScheduler().scheduleKnown(projectId, worktreeId),
    )
    .catch(() => undefined);
}

export async function writeChatTabsSnapshotForTests(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
  delta?: ChatTabsWriteDelta,
): Promise<void> {
  const filePath = resolveChatTabsFilePath(projectId, worktreeId);
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writePrettyJsonCooperatively(tempPath, data);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await ensureChatTabsRequiredDurability(
    projectId,
    worktreeId,
    data,
    delta,
    data.revision ?? 0,
  );
  await notifyChatTabsMaterialized(projectId, worktreeId, data, delta);
}

/**
 * Deprecated compatibility adapter. It no longer writes a snapshot directly;
 * every call is reduced and journaled by the main-owned state service.
 */
export async function writeChatTabsFile(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
  delta?: ChatTabsWriteDelta,
): Promise<void> {
  // Lazy import breaks the compatibility writer/state projection cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().replaceCompatibilityTabs(
    { projectId, worktreeId },
    data,
    delta
      ? {
          changedTabIds: delta.changedTabIds,
          removedTabIds: delta.removedTabIds,
          ...(delta.authoritative ? { authoritative: true } : {}),
        }
      : undefined,
  );
}

function completePersistedTurnTimers(
  messages: PersistedChatMessage[],
  completedAt: number,
): PersistedChatMessage[] {
  return messages.map((message) => {
    const hasOpenTimer = message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        (block.pausedAt == null || block.resumedAt != null),
    );
    if (!hasOpenTimer) {
      return message;
    }

    return {
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'turn_timer' && block.completedAt === null
          ? block.pausedAt == null || block.resumedAt != null
            ? { ...block, completedAt }
            : block
          : block,
      ),
    };
  });
}

export function completePersistedTabTurnTimers(
  tab: PersistedChatTab,
  completedAt: number,
): PersistedChatTab {
  return {
    ...tab,
    messages: completePersistedTurnTimers(tab.messages, completedAt),
  };
}
