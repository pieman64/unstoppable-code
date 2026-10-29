/**
 * Shared capture orchestration for archived containers, so the two container
 * kinds cannot drift: the work-entry delete path commits in one step here,
 * and the worktree flow (`worktree-service.ts`, which must interleave git
 * teardown and pipeline relocation before its commit) reuses the same
 * chat-counting rules via {@link countCapturedChats}.
 */
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import {
  beginArchivedContainerCapture,
  commitArchivedContainer,
  assertArchivedContainerSourceGeneration,
  type ArchivedContainerCaptureBase,
} from './archived-containers';
import { createArchivedContainerTiming } from './archived-container-retention';
import { captureArchivedContainerProviderState } from './archived-container-provider-state';
import { scheduleArchivedContainerDiskUsage } from './archived-container-disk-usage';

/** Manifest chat counts derived from a staged capture. */
export function countCapturedChats(
  capture: ArchivedContainerCaptureBase,
): Pick<ArchivedContainerManifest, 'chatCount' | 'archivedChatCount'> {
  return {
    chatCount: capture.chats.tabs.filter(
      (tab) => (tab.kind ?? 'chat') === 'chat',
    ).length,
    archivedChatCount: capture.chatArchives.archived.length,
  };
}

/**
 * Captures and commits a removed Work Entry (cowork or App Advisor) as an
 * archived container. Deletion retention is always on, so every removal
 * lands here: a plain Delete commits an unlocked ("Deleted") container the
 * sweep removes after `retentionDays`; `lockAfterArchive` commits an
 * "Archived" container that is kept until the user deletes it.
 */
export async function captureWorkEntryArchivedContainer(options: {
  workspaceId: string;
  entryId: string;
  entryTitle: string;
  entryCreatedAt: string;
  retentionDays: number;
  lockAfterArchive?: boolean;
}): Promise<void> {
  const capture = await beginArchivedContainerCapture(
    options.workspaceId,
    options.entryId,
    {
      allowDuringScopeDeletion: true,
      expectedCreatedAt: options.entryCreatedAt,
    },
  );
  try {
    // Non-strict: a plugin-resolution or copy failure (offline marketplace,
    // removed plugin) must degrade to a warning — the chat restores read-only
    // later — instead of making the entry undeletable.
    await captureArchivedContainerProviderState({
      projectId: options.workspaceId,
      containerId: options.entryId,
      tabs: [
        ...capture.chats.tabs,
        ...capture.chatArchives.archived.map((entry) => entry.tab),
      ],
      includeClaude: false,
      onlyPluginCodex: true,
      expectedCreatedAt: options.entryCreatedAt,
    });
    const timing = createArchivedContainerTiming(options.retentionDays);
    await assertArchivedContainerSourceGeneration(
      options.workspaceId,
      options.entryId,
      options.entryCreatedAt,
    );
    await commitArchivedContainer({
      version: 1,
      id: options.entryId,
      kind: 'work-entry',
      projectId: options.workspaceId,
      name: options.entryTitle,
      createdAt: options.entryCreatedAt,
      ...timing,
      ...(options.lockAfterArchive === true
        ? { lockedAt: timing.archivedAt }
        : {}),
      retentionDays: options.retentionDays,
      ...countCapturedChats(capture),
      executionCount: 0,
      originalEntry: {
        id: options.entryId,
        title: options.entryTitle,
        createdAt: options.entryCreatedAt,
      },
    });
    // The archive is complete at commit; measure its footprint off the delete
    // path so the sidebar removal never waits on a directory walk.
    scheduleArchivedContainerDiskUsage(options.workspaceId, options.entryId);
  } catch (error) {
    // Defer the scheduler-backed service until archive-capture rollback;
    // successful capture setup does not need watcher process lifecycle state.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    await getAppAdvisorWatcherService().releaseLocalScopeFence(
      options.workspaceId,
      options.entryId,
    );
    throw error;
  }
}
