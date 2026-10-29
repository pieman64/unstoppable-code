import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
  type CoworkWorkEntryCreateRequest,
  type CoworkWorkEntryCreateResponse,
  type CoworkWorkEntryDeleteRequest,
  type CoworkWorkEntryDeleteResponse,
  type CoworkWorkEntryListRequest,
  type CoworkWorkEntryListResponse,
  type CoworkWorkEntryReorderRequest,
  type CoworkWorkEntryResolveChatRequest,
  type CoworkWorkEntryResolveChatResponse,
  type CoworkWorkEntryUpdateRequest,
} from '@canopy/desktop-shared/types';
import {
  destroyWorktreeSessions,
  getActiveChatIds,
} from '../agents/session-manager';
import {
  createWorkEntry,
  listWorkEntries,
  listWorkEntryChatSummaries,
  onWorkEntryListChanged,
  removeWorkEntryRow,
  reorderWorkEntries,
  resolveWorkEntryForChat,
  updateWorkEntry,
} from '../lib/cowork-work-entries';
import { assertNoLiveDelegationsInWorktree } from '../agents/delegation/activity';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';
import { broadcastArchivedContainersChanged } from '../lib/archived-containers';
import { resolveContainerRetentionDays } from '../lib/archived-container-retention';
import { captureWorkEntryArchivedContainer } from '../lib/archived-container-capture';
import { getChatStateService } from '../services/chat-state-service';
import { getChatQueueService } from '../services/chat-queue-service';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';
import { workEntryLedgerIncarnation } from '../ledger/lifecycle-containers';

/**
 * Tells the Ledger that a Cowork or App Advisor Work Entry was deleted, so its
 * scope becomes read-only when the deletion committed a retained archive
 * manifest, or retires when it did not. Call only after the entry row is
 * irreversibly removed. The participant returns at once, so no deletion lock
 * is held while it waits on Ledger storage.
 */
function notifyLedgerOfWorkEntryDeletion(
  workspaceId: string,
  entry: { readonly id: string; readonly createdAt: string },
  retained: boolean,
): void {
  try {
    notifyLedgerContainerArchived(
      workEntryLedgerIncarnation(workspaceId, entry),
      { retained },
    );
  } catch {
    // The participant never throws. A defect in it must not fail a deletion
    // past its commit point; startup reconciliation settles the scope.
  }
}

function assertWorkEntryWorkspace(projectId: string): string {
  validateId(projectId, 'projectId');
  // App Advisor is an app-managed Work Entry workspace. It deliberately does
  // not participate in workspaces/index.json, so it must bypass cowork
  // migration and indexed-workspace membership checks at this IPC boundary.
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return projectId;
  }
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  if (!isCoworkWorkspace(workspaceId)) {
    throw new Error(`Project ${workspaceId} is not a cowork project`);
  }
  return workspaceId;
}

async function waitForE2eWorkEntryDeletionFenceCheckpoint(): Promise<void> {
  if (!__CANOPY_E2E__) return;
  const rawDelay = process.env.CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS;
  if (!rawDelay) return;
  const delayMs = Number(rawDelay);
  if (!Number.isInteger(delayMs) || delayMs <= 0 || delayMs > 10_000) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function injectE2eProviderEventDuringWorkEntryTeardown(
  workspaceId: string,
  entryId: string,
): Promise<void> {
  if (!__CANOPY_E2E__) return;
  const chatId =
    process.env.CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID;
  if (!chatId) return;
  validateId(chatId, 'chatId');
  await getChatStateService().ingestProviderEvent({
    projectId: workspaceId,
    worktreeId: entryId,
    chatId,
    mutationId: `e2e-work-entry-delete-late-provider:${entryId}:${chatId}`,
    data: {
      type: 'claude_terminal_transcript_sync',
      messages: [
        {
          id: `${chatId}-late-provider-message`,
          role: 'assistant',
          blocks: [
            {
              type: 'text',
              text: 'Late provider output before deletion',
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
  });
}

let stopWorkEntryListProjection: (() => void) | null = null;

/**
 * Creating, deleting, restoring or reordering a Work Entry shifts every
 * sibling's registry index, so re-project the whole cowork workspace's chats
 * to the portal. The emitter no-ops without an active portal session.
 */
function projectWorkEntryListChanges(workspaceId: string): void {
  if (workspaceId === APP_ADVISOR_PROJECT_ID) return;
  // Keep the large standalone-chat service graph off Electron startup, as the
  // handlers below do; the projection is only needed once an entry changes.
  void import('../services/standalone-chat-service')
    .then(({ emitStandaloneWorkspaceWorkEntrySummaries }) =>
      emitStandaloneWorkspaceWorkEntrySummaries(workspaceId),
    )
    .catch(() => undefined);
}

export function registerWorkEntryHandlers(): void {
  stopWorkEntryListProjection?.();
  stopWorkEntryListProjection = onWorkEntryListChanged(
    projectWorkEntryListChanges,
  );
  registerIpcHandler<[CoworkWorkEntryListRequest], CoworkWorkEntryListResponse>(
    IPC_CHANNELS.workEntriesList,
    async (_event, request) => {
      const workspaceId = assertWorkEntryWorkspace(request.projectId);
      // Live session lookup injected here (not statically imported by the
      // registry lib) so hasActiveChat reflects in-flight turns at list time.
      return {
        entries: await listWorkEntries(workspaceId, { getActiveChatIds }),
      };
    },
  );

  registerIpcHandler<
    [CoworkWorkEntryCreateRequest],
    CoworkWorkEntryCreateResponse
  >(IPC_CHANNELS.workEntriesCreate, async (_event, request) => {
    const workspaceId = assertWorkEntryWorkspace(request.projectId);
    return createWorkEntry(workspaceId, {
      ...(request.sidebarItemGroupId === undefined
        ? {}
        : { sidebarItemGroupId: request.sidebarItemGroupId }),
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
  });

  registerIpcHandler<[CoworkWorkEntryUpdateRequest], void>(
    IPC_CHANNELS.workEntriesUpdate,
    async (_event, request) => {
      const workspaceId = assertWorkEntryWorkspace(request.projectId);
      validateId(request.entryId, 'entryId');
      if (
        request.status !== undefined &&
        request.status !== 'active' &&
        request.status !== 'done'
      ) {
        throw new Error(`Invalid work entry status ${String(request.status)}`);
      }
      if (request.pinned !== undefined && typeof request.pinned !== 'boolean') {
        throw new Error('Invalid work entry pinned state');
      }
      await updateWorkEntry(workspaceId, request.entryId, {
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.status !== undefined ? { status: request.status } : {}),
        ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
      });

      if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
        // Keep the large standalone-chat service graph off Electron startup;
        // work-entry handlers do not need it until cowork projection runs.
        const { emitStandaloneWorkEntrySummary } =
          await import('../services/standalone-chat-service');
        await emitStandaloneWorkEntrySummary(workspaceId, request.entryId);
      }

      // A rename or a mark-done is usually the LAST action on an entry, so no
      // subsequent turn will carry the new metadata to the server. Both feed
      // the Impact delivery track (linkage bonus from a ticket id in the title,
      // done bonus from the status), so push an envelope-only metadata refresh
      // rather than waiting for content that will never arrive. Fire-and-forget:
      // the registry write already succeeded and telemetry must not fail a
      // local edit. No-ops when telemetry sync is off.
      void getTelemetrySyncService()
        .refreshWorktreeMetadata(workspaceId, request.entryId)
        .catch(() => undefined);
      if (workspaceId === APP_ADVISOR_PROJECT_ID) {
        const { projectAppAdvisorChatSummaries } =
          await import('../services/chat-service');
        await projectAppAdvisorChatSummaries(request.entryId);
      }
    },
  );

  registerIpcHandler<[CoworkWorkEntryReorderRequest], void>(
    IPC_CHANNELS.workEntriesReorder,
    async (_event, request) => {
      const workspaceId = assertWorkEntryWorkspace(request.projectId);
      request.entryIds.forEach((entryId) => validateId(entryId, 'entryId'));
      await reorderWorkEntries(workspaceId, request.entryIds);
      if (workspaceId === APP_ADVISOR_PROJECT_ID) {
        const { projectAllAppAdvisorChatSummaries } =
          await import('../services/chat-service');
        await projectAllAppAdvisorChatSummaries();
      }
    },
  );

  registerIpcHandler<
    [CoworkWorkEntryDeleteRequest],
    CoworkWorkEntryDeleteResponse
  >(IPC_CHANNELS.workEntriesDelete, async (_event, request) => {
    const workspaceId = assertWorkEntryWorkspace(request.projectId);
    validateId(request.entryId, 'entryId');
    if (
      workspaceId === APP_ADVISOR_PROJECT_ID &&
      request.entryId === APP_ADVISOR_WORKTREE_ID
    ) {
      throw new Error('The legacy App Advisor global slot cannot be deleted');
    }
    const entries = await listWorkEntries(workspaceId);
    const entry = entries.find((candidate) => candidate.id === request.entryId);
    if (!entry) {
      throw new Error(`Unknown work entry ${request.entryId}`);
    }
    // A chat with live delegates keeps its Work Entry (the row shows working).
    assertNoLiveDelegationsInWorktree(workspaceId, request.entryId);
    const retentionDays = await resolveContainerRetentionDays(workspaceId);
    let retained = false;
    let removedChatIds: string[] = [];
    let browserCleanupPending = false;
    const chatStateService = getChatStateService();
    const scope = {
      projectId: workspaceId,
      worktreeId: request.entryId,
    };
    await chatStateService.runWithScopeDeletionLifecycle(scope, async () => {
      const queueDeletion = getChatQueueService().beginWorktreeDeletion(
        workspaceId,
        request.entryId,
      );
      let queueDeletionCommitted = false;
      let sessionsDestroyed = false;
      let entryRowRemoved = false;
      // Defer the browser lifecycle module until deletion enters its fenced
      // transaction so ordinary work-entry IPC startup avoids Electron session work.
      const {
        prepareTaskBrowserRetirement,
        commitTaskBrowserRetirement,
        abortTaskBrowserRetirement,
      } = await import('../browser/browser-profile-lifecycle');
      let browserRetirement: string | null = null;
      try {
        browserRetirement = await prepareTaskBrowserRetirement(
          workspaceId,
          request.entryId,
        );
        await waitForE2eWorkEntryDeletionFenceCheckpoint();
        // Exercise the repository-write window used by provider teardown
        // callbacks: commands are fenced, but terminal event commits must
        // still land before session drain and archive capture.
        await injectE2eProviderEventDuringWorkEntryTeardown(
          workspaceId,
          request.entryId,
        );
        await destroyWorktreeSessions(workspaceId, request.entryId);
        sessionsDestroyed = true;
        await chatStateService.runWithScopeDeletion(scope, async () => {
          if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
            const summaries = await listWorkEntryChatSummaries(workspaceId);
            removedChatIds =
              summaries
                .find((candidate) => candidate.entryId === request.entryId)
                ?.chats.map((chat) => chat.id) ?? [];
          }
          // Deletion retention is always on: every removal lands in the
          // archive, either as a "Deleted" item the sweep purges after
          // `retentionDays` or — when the caller asked to archive — as a
          // locked "Archived" item kept until the user deletes it.
          await captureWorkEntryArchivedContainer({
            workspaceId,
            entryId: request.entryId,
            entryTitle: entry.title,
            entryCreatedAt: entry.createdAt,
            retentionDays,
            ...(request.lockAfterArchive === true
              ? { lockAfterArchive: true }
              : {}),
          });
          retained = true;
          // Drain and drop this entry's telemetry queue, mirroring what code
          // worktrees do via `worktree-live-cleanup`. Newly load-bearing: a
          // `metaDirty` envelope has no collection items, so nothing else would
          // ever retire it — a mark-done followed by a delete would otherwise leave
          // an immortal queue entry that keeps uploading metadata for a Work Entry
          // that no longer exists locally.
          await getTelemetrySyncService()
            .drainWorktreeForDeletion(workspaceId, request.entryId)
            .catch(() => undefined);
          await cleanupPersistedWorktreeData(workspaceId, request.entryId, {
            chatSearchDisposition: retained ? 'container-archived' : 'delete',
            deferLocalWatcherCancellationCommit: true,
          });
          await removeWorkEntryRow(workspaceId, request.entryId);
          entryRowRemoved = true;
          notifyLedgerOfWorkEntryDeletion(workspaceId, entry, retained);
          schedulePortalStructuralSync();
          browserCleanupPending = await commitTaskBrowserRetirement(
            workspaceId,
            request.entryId,
          );
          // Defer the scheduler-backed service until this deletion reaches
          // its irreversible row-removal commit point.
          const { getAppAdvisorWatcherService } =
            await import('../app-advisor/watchers');
          await getAppAdvisorWatcherService().commitLocalScopeCancellation(
            workspaceId,
            request.entryId,
          );
        });
        queueDeletion.commit();
        queueDeletionCommitted = true;
      } catch (error) {
        // Defer the scheduler-backed service until rollback is necessary;
        // the work-entry IPC module otherwise has no watcher dependency.
        const { getAppAdvisorWatcherService } =
          await import('../app-advisor/watchers');
        if (!entryRowRemoved) {
          await abortTaskBrowserRetirement(browserRetirement);
          await getAppAdvisorWatcherService().releaseLocalScopeFence(
            workspaceId,
            request.entryId,
          );
        }
        throw error;
      } finally {
        if (!queueDeletionCommitted) {
          queueDeletion.rollback({ sessionsDestroyed });
        }
      }
    });
    if (workspaceId !== APP_ADVISOR_PROJECT_ID) {
      // Keep the large standalone-chat service graph off Electron startup;
      // work-entry handlers do not need it until cowork removal runs.
      const { emitStandaloneChatRemovals } =
        await import('../services/standalone-chat-service');
      emitStandaloneChatRemovals(workspaceId, removedChatIds);
    }
    if (retained) broadcastArchivedContainersChanged(workspaceId);
    return { browserCleanupPending };
  });

  registerIpcHandler<
    [CoworkWorkEntryResolveChatRequest],
    CoworkWorkEntryResolveChatResponse
  >(IPC_CHANNELS.workEntriesResolveChat, async (_event, request) => {
    const workspaceId = assertWorkEntryWorkspace(request.projectId);
    validateId(request.chatId, 'chatId');
    return resolveWorkEntryForChat(workspaceId, request.chatId);
  });
}
