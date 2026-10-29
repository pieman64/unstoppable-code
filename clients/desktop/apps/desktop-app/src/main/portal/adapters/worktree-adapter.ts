import { isSidebarItemGroupId } from '@canopy/protocol/sidebar';
import {
  IPC_CHANNELS,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  type CreateWorktreeServiceOptions,
} from '../../lib/worktree-service';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceWorktree,
  updateWorkspaceWorktrees,
} from '../../lib/workspace-persistence';
import { recordWorktreeCrudTelemetry } from '../../lib/desktop-telemetry';
import { validateId } from '../../lib/validation';
import {
  archiveWorktree,
  WorktreeArchiveRefusedError,
} from '../../lib/worktree-archive';
import { sendToWindow } from '../../lib/window-send';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';
import { forkOpenWorktreeTabs } from '../../lib/worktree-open-tabs-fork';
import { createPortalEvent } from '../portal-event-bus';
import { isWorkspaceTargetRemovalPending } from '../../lib/workspace-target-exclusion';
import {
  getWorkspacePortalWorktreeEntity,
  getWorkspacePortalWorktreeRuntimeStatus,
} from '../../services/workspace-portal-service';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

const GENERIC_WORKTREE_CREATE_FAILURE =
  'Failed to create the task worktree. Check the repository state, then try again.';

/** Push the authoritative post-setup row without issuing another portal command. */
async function publishPortalWorktreeSetupStatus(
  context: PortalAdapterContext,
  workspaceId: string,
  worktreeId: string,
  setupError?: string,
): Promise<void> {
  try {
    // Archiving cancels in-flight setup. A row missing because it is being
    // removed, or was while this read ran, is not a failed setup to report.
    const removalPendingBeforeRead = isWorkspaceTargetRemovalPending(
      workspaceId,
      worktreeId,
    );
    const runtimeStatus = await getWorkspacePortalWorktreeRuntimeStatus(
      workspaceId,
      worktreeId,
    );
    const entity = await getWorkspacePortalWorktreeEntity(
      workspaceId,
      worktreeId,
      runtimeStatus,
    );
    const removalPending =
      removalPendingBeforeRead ||
      isWorkspaceTargetRemovalPending(workspaceId, worktreeId);
    context.enqueueEvent(
      createPortalEvent('portal.state.delta', {
        scope: 'worktree',
        target: {
          workspaceLocalId: workspaceId,
          worktreeLocalId: worktreeId,
        },
        ...(entity
          ? { entities: [entity] }
          : {
              removed: [
                {
                  entityType: 'worktree',
                  localId: worktreeId,
                  parentLocalId: workspaceId,
                },
              ],
            }),
        ...(setupError && !entity && !removalPending
          ? {
              worktreeSetupFailure: {
                workspaceLocalId: workspaceId,
                worktreeLocalId: worktreeId,
                error: setupError,
              },
            }
          : {}),
        generatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Persistence also schedules an overview snapshot. This direct status
    // delta is the low-latency path, so a projection failure remains best-effort.
  }
}

/**
 * Notify the desktop renderer that a portal-initiated mutation changed a
 * workspace's persisted worktree list. The renderer never initiated the write,
 * so without this the sidebar goes stale until an unrelated full reload
 * (CAN-1304). Broadcasts the authoritative full post-mutation list — the shape
 * `applyWorkspaceWorktreeUpdatedEvent` uses to ADD and REMOVE rows — and falls
 * back to a workspace-id-only event (renderer does a debounced silent reload)
 * if the list cannot be re-read.
 */
async function broadcastWorktreeListToRenderer(
  context: PortalAdapterContext,
  workspaceId: string,
): Promise<void> {
  let worktrees: WorktreeData[] | undefined;
  try {
    // Note: readWorkspaceWorktrees may prune stale rows and re-write
    // worktrees.json (self-heal), which resets the portal-sync debounce in
    // portal-structural-sync. Harmless — the extra fire is the same
    // idempotent overview push — but it means this read can schedule a push.
    worktrees = await readWorkspaceWorktrees(workspaceId);
  } catch {
    worktrees = undefined;
  }
  sendToWindow(
    context.getWindow?.() ?? null,
    IPC_CHANNELS.workspaceWorktreesUpdated,
    Array.isArray(worktrees) ? { workspaceId, worktrees } : { workspaceId },
  );
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return items;
  next.splice(toIndex, 0, moved);
  return next;
}

/** Update a worktree label and/or hidden state. */
export async function handlePortalWorktreeUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.worktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree update payload: workspaceId and worktreeId are required.',
    );
    return;
  }
  const hasLabel = Object.prototype.hasOwnProperty.call(payload, 'label');
  const hasHidden = Object.prototype.hasOwnProperty.call(payload, 'hidden');
  if (
    (!hasLabel && !hasHidden) ||
    (hasLabel && payload.label !== null && typeof payload.label !== 'string') ||
    (hasHidden && typeof payload.hidden !== 'boolean')
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Worktree update requires a string/null label and/or a boolean hidden value.',
    );
    return;
  }

  try {
    validateId(payload.workspaceId, 'workspaceId');
    validateId(payload.worktreeId, 'worktreeId');
    const workspaceId = payload.workspaceId;
    const worktreeId = payload.worktreeId;
    const nextLabel =
      hasLabel && typeof payload.label === 'string'
        ? payload.label.trim()
        : undefined;
    let updatedWorktree: WorktreeData | undefined;
    const persistUpdate = (): Promise<boolean> =>
      updateWorkspaceWorktree(workspaceId, worktreeId, (worktree) => {
        const next = { ...worktree };
        if (hasLabel) {
          if (nextLabel) next.label = nextLabel;
          else delete next.label;
        }
        if (hasHidden) {
          if (payload.hidden === true) next.hidden = true;
          else delete next.hidden;
        }
        updatedWorktree = next;
        return next;
      });
    const persisted = await persistUpdate();
    if (!persisted) {
      context.fail(command, 'not_found', 'Worktree to update was not found.');
      return;
    }
    sendToWindow(
      context.getWindow?.() ?? null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId, worktree: updatedWorktree },
    );
    context.complete(command, { success: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/** Persist a visible-worktree drag move while preserving hidden row slots. */
export async function handlePortalWorktreeReorder(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.activeWorktreeId !== 'string' ||
    typeof payload.overWorktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree reorder payload: workspaceId, activeWorktreeId, and overWorktreeId are required.',
    );
    return;
  }

  try {
    validateId(payload.workspaceId, 'workspaceId');
    validateId(payload.activeWorktreeId, 'activeWorktreeId');
    validateId(payload.overWorktreeId, 'overWorktreeId');
    const config = await readWorkspaceConfig(payload.workspaceId);
    if (config.type === 'cowork') {
      context.fail(command, 'not_found', 'Project to reorder was not found.');
      return;
    }
    let persisted = false;
    const worktrees = await updateWorkspaceWorktrees(
      payload.workspaceId,
      (worktrees) => {
        const visible = worktrees.filter((worktree) => !worktree.hidden);
        const fromIndex = visible.findIndex(
          (worktree) => worktree.id === payload.activeWorktreeId,
        );
        const toIndex = visible.findIndex(
          (worktree) => worktree.id === payload.overWorktreeId,
        );
        if (fromIndex < 0 || toIndex < 0) return worktrees;
        const reorderedVisible = moveItem(visible, fromIndex, toIndex);
        let visibleIndex = 0;
        persisted = true;
        return worktrees.map((worktree) => {
          if (worktree.hidden) return worktree;
          const replacement = reorderedVisible[visibleIndex];
          visibleIndex += 1;
          return replacement ?? worktree;
        });
      },
    );
    if (!persisted) {
      context.fail(command, 'not_found', 'Worktree to reorder was not found.');
      return;
    }
    sendToWindow(
      context.getWindow?.() ?? null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: payload.workspaceId, worktrees },
    );
    context.complete(command, {
      workspaceId: payload.workspaceId,
      activeWorktreeId: payload.activeWorktreeId,
      overWorktreeId: payload.overWorktreeId,
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Handle `portal.worktree.create` — create a new worktree ("task") in a
 * workspace from the browser Remote Control sidebar (the workspace add "+" /
 * "Create Task"). Reuses the exact desktop services the renderer uses
 * (`createSingleRepoWorktree` / `createMultiRepoWorktree`), dispatching on the
 * authoritative persisted workspace type and rejecting `cowork` workspaces
 * (which have no worktrees), same as the renderer IPC path.
 *
 * Git setup is deferred through the existing two-phase worktree lifecycle, so
 * this command acknowledges the persisted `git-pending` reservation without
 * holding the portal's serial command lane through fetch/worktree creation.
 * Ready/failure callbacks notify both the desktop renderer and the portal with
 * the authoritative post-setup row. Auto-running post-create setup scripts
 * remains a tracked follow-up (`startPostCreateSetup: false`); the user can run
 * Setup from the Scripts panel after Git is ready.
 */
export async function handlePortalWorktreeCreate(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.worktree.create']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  // The payload is browser-supplied and only shape/size-validated in transit,
  // so re-validate the fields here (read through `unknown` so the guards are
  // real runtime checks, not type-narrowed no-ops).
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    (payload.sidebarItemGroupId !== undefined &&
      !isSidebarItemGroupId(payload.sidebarItemGroupId))
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree create payload: workspaceId is required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  const filteredExistingIds = Array.isArray(payload.existingWorktreeIds)
    ? payload.existingWorktreeIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : undefined;
  // Coalesce an empty array to `undefined` so the create service falls back to
  // reading the persisted worktree list for default-branch uniqueness.
  const existingWorktreeIds =
    filteredExistingIds && filteredExistingIds.length > 0
      ? filteredExistingIds
      : undefined;
  const baseWorktreeId =
    typeof payload.baseWorktreeId === 'string'
      ? payload.baseWorktreeId
      : undefined;

  try {
    validateId(workspaceId, 'workspaceId');
    if (baseWorktreeId) {
      validateId(baseWorktreeId, 'baseWorktreeId');
    }
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree create payload: workspaceId and baseWorktreeId must use lowercase letters, numbers, and hyphens.',
      false,
    );
    return;
  }

  try {
    // Dispatch on the authoritative persisted workspace type (not the in-memory
    // sidebar registry) so a stale/unpopulated registry can't misroute, and
    // reject cowork workspaces explicitly — matching the renderer IPC path.
    const config = await readWorkspaceConfig(workspaceId);
    if (config.type === 'cowork') {
      context.fail(
        command,
        'invalid_payload',
        'Cannot create a worktree in a cowork project.',
      );
      return;
    }
    const options: CreateWorktreeServiceOptions = {
      workspaceId,
      ...(isSidebarItemGroupId(payload.sidebarItemGroupId)
        ? { sidebarItemGroupId: payload.sidebarItemGroupId }
        : {}),
      existingWorktreeIds,
      baseWorktreeId,
      startPostCreateSetup: false,
      deferGitSetup: true,
      beforeGitReady: async (event): Promise<void> => {
        if (payload.forkOpenTabs === true && baseWorktreeId) {
          try {
            await forkOpenWorktreeTabs({
              projectId: workspaceId,
              sourceWorktreeId: baseWorktreeId,
              destinationWorktreeId: event.worktreeId,
            });
          } catch {
            // Tab inheritance is best effort. It must settle before readiness
            // so it cannot replace a tab opened by a readiness consumer.
          }
        }
      },
      onGitReady: (event): void => {
        sendToWindow(
          context.getWindow?.() ?? null,
          IPC_CHANNELS.worktreeGitReady,
          event,
        );
        trackDetachedWork(() =>
          publishPortalWorktreeSetupStatus(
            context,
            event.projectId,
            event.worktreeId,
          ),
        );
      },
      onGitFailed: (event): void => {
        sendToWindow(
          context.getWindow?.() ?? null,
          IPC_CHANNELS.worktreeGitFailed,
          event,
        );
        trackDetachedWork(() =>
          publishPortalWorktreeSetupStatus(
            context,
            event.projectId,
            event.worktreeId,
            event.error,
          ),
        );
      },
    };
    const result =
      config.type === 'multi-repo'
        ? await createMultiRepoWorktree(options)
        : await createSingleRepoWorktree(options);
    recordWorktreeCrudTelemetry({
      action: 'create',
      workspaceId,
      source: 'portal',
    });
    await broadcastWorktreeListToRenderer(context, workspaceId);
    context.complete(command, result);
    await broadcastWorkspaceWorktrees(context, workspaceId);
  } catch {
    context.fail(
      command,
      'execution_failed',
      GENERIC_WORKTREE_CREATE_FAILURE,
      false,
    );
  }
}

/**
 * Best-effort renderer refresh after a committed mutation. Runs OUTSIDE the
 * command's try/catch and after `context.complete` on purpose: the mutation
 * has already succeeded, so a failed follow-up read must not misreport the
 * command as failed (the renderer converges on its next full load instead).
 */
async function broadcastWorkspaceWorktrees(
  context: PortalAdapterContext,
  workspaceId: string,
): Promise<void> {
  try {
    const worktrees = await readWorkspaceWorktrees(workspaceId);
    sendToWindow(
      context.getWindow?.() ?? null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId, worktrees },
    );
  } catch {
    // Swallowed by design — see doc comment above; `no-console` bars logging.
  }
}

/**
 * Handle `portal.worktree.archive` — remove an active worktree from the
 * browser Remote Control sidebar and retain a restorable archive according to
 * the requested mode. The browser gates it behind the
 * `canopy-portal-destructive-actions` flag and a confirmation dialog, and this
 * adapter preserves the desktop-side safety the renderer IPC path applies:
 * the split-lock guard (refuse while a split PR is in progress), the
 * live-service cleanup callbacks, and the post-archive GitHub sync. Reuses the
 * exact renderer services (`archiveSingleRepoWorktree` /
 * `archiveMultiRepoWorktree`, dispatched by the persisted workspace type;
 * cowork rejected). The archive service resolves the origin `repoPath` itself
 * from the workspace config, so this adapter does not pass one.
 */
export async function handlePortalWorktreeArchive(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.worktree.archive']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const payload: unknown = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.worktreeId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid worktree archive payload: workspaceId and worktreeId are required.',
    );
    return;
  }
  const workspaceId = payload.workspaceId;
  const worktreeId = payload.worktreeId;
  const mode = payload.mode;
  if (mode !== undefined && mode !== 'archive' && mode !== 'delete') {
    context.fail(command, 'invalid_payload', 'Invalid worktree archive mode.');
    return;
  }

  try {
    // The archive boundary resolves the stable origin repo path itself from
    // the project config, so no `repoPath` is passed: the worktree's own
    // checkout is the directory being removed.
    const result = await archiveWorktree({
      workspaceId,
      worktreeId,
      source: 'portal',
      ...(mode !== 'delete' ? { lockAfterArchive: true } : {}),
    });
    await broadcastWorktreeListToRenderer(context, workspaceId);
    context.complete(command, result);
    await broadcastWorkspaceWorktrees(context, workspaceId);
  } catch (error) {
    if (error instanceof WorktreeArchiveRefusedError) {
      context.fail(
        command,
        error.reason === 'not-found' ? 'not_found' : 'invalid_payload',
        error.message,
      );
      return;
    }
    failServiceError(command, context, error);
  }
}
