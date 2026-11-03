import {
  W5_PROJECTION_ONLY_READ,
  withW5ProjectionOnlyRead,
} from '../lib/w5-fallback-read';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { projectedSourceCompositionCommands } from '../canopy-runtime/source-composition-dispatch';
import {
  IPC_CHANNELS,
  type DeleteProjectRequest,
  type ProjectApplySourceChangesRequest,
  type ProjectApplySourceChangesResponse,
  type SaveDefaultPluginsRequest,
  type SidebarItem,
  type SidebarItemsFile,
  type SidebarItemsSaveOptions,
  type ReorderWorkspacesRequest,
  type SetTrackedBaseBranchRequest,
  type UpdateWorkspaceMetadataRequest,
} from '@canopy/desktop-shared/types';
import {
  hasVisibleWorkspaceContent,
  isRetiredTemporaryWorkspace,
} from '@canopy/desktop-shared/lib/workspace-visibility';
import { applySourceChanges } from '../lib/workspace-source-changes';
import { assertStartPageFeatureEnabled } from '../lib/start-page-feature-flag';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { sendToWindow } from '../lib/window-send';
import { reconcileGitPendingWorktrees } from '../lib/worktree-boot-recovery';
import {
  readAllSidebarItems,
  validateSidebarItems,
} from '../lib/sidebar-items';
import { saveSidebarItems } from '../lib/sidebar-save-adapter';
import {
  projectedWorkspaceGuardedCommands,
  type ProjectedWorkspaceGuardedCommands,
} from '../canopy-runtime/workspace-guarded-dispatch';
import { readPreferencesFile } from '../lib/preferences-store';
import { getSidebarItemsPreserveWorkspaceIds } from '../lib/sidebar-items-preservation';
import { syncTrackedWorktrees as syncTrackedGitHubWorktrees } from '../lib/github-poller';
import { repairExistingWorkspaceRootWorktrees } from '../lib/workspace-source-control';
import { publishWorktreeLifecycleChange } from '../lib/worktree-lifecycle-signals';
import { syncWorktreesFileWatchers } from '../lib/worktrees-file-watcher';
import { reconcileExternalWorktreeSnapshot } from '../lib/worktree-registry-reconciliation';
import {
  startPolling,
  syncTrackedWorkspaces,
} from '../lib/workspace-reference-repo-poller';
import { recordWorkspaceCrudTelemetry } from '../lib/desktop-telemetry';
import {
  startCodeGraphBaseManager,
  syncCodeGraphBaseRepositories,
} from '../lib/code-graph-base-manager';
import { backfillMissingWorktreeChatBadges } from '../lib/chat-badge-sync';
import { registerIpcHandler } from './register';
import {
  projectedWorkspaceMetadataCommands,
  type ProjectedWorkspaceMetadataCommands,
} from '../canopy-runtime/workspace-metadata-dispatch';
import { projectedWorkspaceLifecycleCommands } from '../canopy-runtime/workspace-lifecycle-dispatch';
import { recordRealisticStartupPerformanceEvent } from '../lib/realistic-startup-performance';
import { WorktreeUpdateRefusedError } from '../lib/worktree-update';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import { deleteWorkspace } from '../lib/workspace-deletion';
import { saveDefaultPluginsAndVisibility } from '../lib/workspace-default-plugins-save';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function isVisibleSidebarItem(item: SidebarItem): boolean {
  return !isRetiredTemporaryWorkspace(item);
}

function getFailedWorkspaceIds(
  sidebarItems: Pick<SidebarItemsFile, 'warnings' | 'preservedWorkspaceIds'>,
): ReadonlySet<string> {
  return new Set(getSidebarItemsPreserveWorkspaceIds(sidebarItems));
}

const FIRST_PROJECTS_LOAD_MAIN_OBSERVER_KEY =
  '__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__';

type FirstProjectsLoadMainObserver = (
  event: IpcMainInvokeEvent | undefined,
  stage: string,
  details: Record<string, unknown>,
) => unknown;

const FIRST_PROJECTS_LOAD_ERROR_CODES = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'EIO',
  'ETIMEDOUT',
  'ECONNRESET',
  'ERR_IPC_CHANNEL_CLOSED',
] as const;
type FirstProjectsLoadErrorCode =
  (typeof FIRST_PROJECTS_LOAD_ERROR_CODES)[number];

function isFirstProjectsLoadErrorCode(
  value: unknown,
): value is FirstProjectsLoadErrorCode {
  return (
    typeof value === 'string' &&
    FIRST_PROJECTS_LOAD_ERROR_CODES.some((candidate) => candidate === value)
  );
}

function isFirstProjectsLoadMainObserver(
  value: unknown,
): value is FirstProjectsLoadMainObserver {
  return typeof value === 'function';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

let projectsLoadRequestOrdinal = 0;

function getFirstProjectsLoadMainObserver():
  | FirstProjectsLoadMainObserver
  | undefined {
  if (!__CANOPY_E2E__) return undefined;
  try {
    const observer: unknown = Reflect.get(
      globalThis,
      FIRST_PROJECTS_LOAD_MAIN_OBSERVER_KEY,
    );
    return isFirstProjectsLoadMainObserver(observer) ? observer : undefined;
  } catch {
    return undefined;
  }
}

function classifyFirstProjectsLoadError(error: unknown): {
  errorKind:
    | 'error'
    | 'type-error'
    | 'range-error'
    | 'syntax-error'
    | 'non-error'
    | 'unknown';
  errorCode?:
    | 'ENOENT'
    | 'EACCES'
    | 'EPERM'
    | 'EIO'
    | 'ETIMEDOUT'
    | 'ECONNRESET'
    | 'ERR_IPC_CHANNEL_CLOSED'
    | 'unknown';
} {
  try {
    const errorKind =
      error instanceof TypeError
        ? 'type-error'
        : error instanceof RangeError
          ? 'range-error'
          : error instanceof SyntaxError
            ? 'syntax-error'
            : error instanceof Error
              ? 'error'
              : error === null ||
                  [
                    'string',
                    'number',
                    'boolean',
                    'bigint',
                    'undefined',
                  ].includes(typeof error)
                ? 'non-error'
                : 'unknown';
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
      return { errorKind };
    }
    const code: unknown = 'code' in error ? error.code : undefined;
    return {
      errorKind,
      ...(typeof code === 'string'
        ? {
            errorCode: isFirstProjectsLoadErrorCode(code) ? code : 'unknown',
          }
        : {}),
    };
  } catch {
    return { errorKind: 'unknown' };
  }
}

function projectFirstProjectsLoadItems(
  items: readonly SidebarItem[],
  warnings: SidebarItemsFile['warnings'],
): Record<string, unknown> {
  const workspaceIds: string[] = [];
  const worktreeIds: string[] = [];
  let invalidIdCount = 0;
  let workspaceInspectedCount = 0;
  let worktreeInspectedCount = 0;
  let worktreeOmittedCount = 0;
  let worktreeOmittedCountAvailable = true;
  const safeId = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[a-z0-9._-]+$/i.test(value);
  try {
    for (
      let index = 0;
      index < items.length &&
      workspaceIds.length < 8 &&
      workspaceInspectedCount < 16;
      index++
    ) {
      workspaceInspectedCount++;
      let item: SidebarItem | undefined;
      try {
        item = items[index];
      } catch {
        invalidIdCount++;
        continue;
      }
      if (!item) continue;
      if (safeId(item.id)) workspaceIds.push(item.id);
      else invalidIdCount++;
      const worktrees = 'worktrees' in item ? item.worktrees : [];
      const inspectedBeforeItem = worktreeInspectedCount;
      for (
        let worktreeIndex = 0;
        worktreeIndex < worktrees.length &&
        worktreeIds.length < 32 &&
        worktreeInspectedCount < 64;
        worktreeIndex++
      ) {
        worktreeInspectedCount++;
        let id: unknown;
        try {
          id = worktrees[worktreeIndex]?.id;
        } catch {
          invalidIdCount++;
          continue;
        }
        if (safeId(id)) worktreeIds.push(id);
        else invalidIdCount++;
      }
      worktreeOmittedCount += Math.max(
        0,
        worktrees.length - (worktreeInspectedCount - inspectedBeforeItem),
      );
    }
  } catch {
    invalidIdCount++;
    worktreeOmittedCountAvailable = false;
  }
  const workspaceOmittedCount = Math.max(
    0,
    items.length - workspaceInspectedCount,
  );
  if (workspaceOmittedCount > 0) worktreeOmittedCountAvailable = false;
  const warningIdentities: Array<Record<string, string>> = [];
  let warningInspectedCount = 0;
  let remainingWarningWorkspaceIds = Math.max(0, 8 - workspaceIds.length);
  try {
    for (
      let index = 0;
      index < (warnings?.length ?? 0) &&
      warningIdentities.length < 8 &&
      warningInspectedCount < 16;
      index++
    ) {
      warningInspectedCount++;
      const warning = warnings?.[index];
      if (!warning) continue;
      const identity: Record<string, string> = {};
      if (remainingWarningWorkspaceIds > 0 && safeId(warning.workspaceId)) {
        identity.workspaceId = warning.workspaceId;
        remainingWarningWorkspaceIds--;
      } else if (!safeId(warning.workspaceId)) invalidIdCount++;
      if (
        warning.code === 'invalid-canopy-json' ||
        warning.code === 'workspace-load-failed'
      )
        identity.code = warning.code;
      warningIdentities.push(identity);
    }
  } catch {
    invalidIdCount++;
  }
  const warningCount = warnings?.length ?? 0;
  return {
    itemCount: items.length,
    workspaceIds,
    worktreeIds,
    warningCount,
    warningIdentities,
    invalidIdCount,
    workspaceInspectedCount,
    workspaceOmittedCount,
    worktreeInspectedCount,
    ...(worktreeOmittedCountAvailable ? { worktreeOmittedCount } : {}),
    worktreeOmittedCountAvailable,
    warningInspectedCount,
    warningOmittedCount: Math.max(0, warningCount - warningInspectedCount),
    truncated:
      workspaceOmittedCount > 0 ||
      worktreeOmittedCount > 0 ||
      warningCount > warningInspectedCount ||
      worktreeIds.length === 32,
    worktreeCountAvailable: false,
  };
}

function observeFirstProjectsLoadMain(
  observer: FirstProjectsLoadMainObserver | undefined,
  event: IpcMainInvokeEvent | undefined,
  stage: string,
  details: () => Record<string, unknown>,
): void {
  if (!observer || getFirstProjectsLoadMainObserver() !== observer) return;
  try {
    const result = observer(event, stage, details());
    if (isPromiseLike(result)) {
      trackDetachedWork(() => Promise.resolve(result).catch(() => undefined));
    }
  } catch {
    /* E2E observation must never enter the product error path. */
  }
}

export function registerProjectHandlers(
  getWindow: () => BrowserWindow | null,
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor,
): void {
  const deliveredSidebarItems = new WeakMap<
    IpcMainInvokeEvent['sender'],
    readonly SidebarItem[]
  >();
  startPolling(getWindow, dispatcher);
  recordRealisticStartupPerformanceEvent('startup:github-poller:started');
  startCodeGraphBaseManager();
  let didReconcileGitPendingWorktrees = false;
  let didScheduleChatBadgeBackfill = false;
  const reconcileExternalSnapshot = (
    workspaceId: string,
    worktrees: Parameters<typeof reconcileExternalWorktreeSnapshot>[1],
  ): void => {
    // The async body handles cleanup errors, but a synchronous throw before
    // its first await would otherwise become an unhandled rejection.
    trackDetachedWork(() =>
      reconcileExternalWorktreeSnapshot(workspaceId, worktrees).catch(() => {
        // Reconciliation is retried on the next watcher event; never crash main.
      }),
    );
  };

  registerIpcHandler(IPC_CHANNELS.projectsLoad, async (event) => {
    const observer = __CANOPY_E2E__
      ? getFirstProjectsLoadMainObserver()
      : undefined;
    const requestOrdinal = observer ? ++projectsLoadRequestOrdinal : undefined;
    if (__CANOPY_E2E__)
      observeFirstProjectsLoadMain(
        observer,
        event,
        'projects-load-main-entered',
        () => ({
          requestOrdinal,
          reconciliationAlreadyAttempted: didReconcileGitPendingWorktrees,
        }),
      );
    try {
      const initial = (
        await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
          dispatcher.queryWorkspaceListForLegacyIpc(
            {},
            { caller: resolveCaller(event) },
          ),
        )
      ).legacyResult;
      // A stale projection may only be delivered, never reconciled or remembered.
      if (initial.stale)
        return {
          ...initial,
          items: initial.items.filter(isVisibleSidebarItem),
        };
      const initialItems = initial.items.filter(isVisibleSidebarItem);
      const initialFailedWorkspaceIds = getFailedWorkspaceIds(initial);
      syncTrackedGitHubWorktrees(initialItems, initialFailedWorkspaceIds);
      syncTrackedWorkspaces(initialItems, initialFailedWorkspaceIds);
      syncCodeGraphBaseRepositories(initialItems, initialFailedWorkspaceIds);
      await settleAll(
        initialItems.map(async (item) => {
          if (item.type !== 'multi-repo' || !item.sourceRepoPath) {
            return;
          }

          await repairExistingWorkspaceRootWorktrees(item.id).catch(() => {});
        }),
      );
      const refreshed = (
        await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
          dispatcher.queryWorktreeListForLegacyIpc(
            {},
            { caller: resolveCaller(event) },
          ),
        )
      ).legacyResult;
      if (Array.isArray(refreshed))
        throw new Error('Unscoped worktree projection was not captured.');
      if (refreshed.stale)
        return {
          ...refreshed,
          items: refreshed.items.filter(isVisibleSidebarItem),
        };
      if (!didReconcileGitPendingWorktrees) {
        didReconcileGitPendingWorktrees = true;
        // Recovery may copy an interrupted archive for minutes. It owns its
        // existing lifecycle locks and publishes changes when it finishes;
        // loading the project inventory must not wait for that maintenance.
        trackDetachedWork(() =>
          reconcileGitPendingWorktrees(getWindow).catch(
            (error: unknown): void => {
              const message =
                error instanceof Error ? error.message : String(error);
              process.stderr.write(
                `[worktree-boot-recovery] Startup recovery failed: ${message}\n`,
              );
            },
          ),
        );
      }
      const refreshedItems = refreshed.items.filter(isVisibleSidebarItem);
      const refreshedFailedWorkspaceIds = getFailedWorkspaceIds(refreshed);
      syncTrackedGitHubWorktrees(refreshedItems, refreshedFailedWorkspaceIds);
      syncTrackedWorkspaces(refreshedItems, refreshedFailedWorkspaceIds);
      syncCodeGraphBaseRepositories(
        refreshedItems,
        refreshedFailedWorkspaceIds,
      );
      // Main's branch observer reads membership itself; the first load
      // starts its enrollment and later loads reread it.
      publishWorktreeLifecycleChange('projects-loaded');
      syncWorktreesFileWatchers(
        refreshedItems,
        getWindow,
        refreshedFailedWorkspaceIds,
        reconcileExternalSnapshot,
      );
      if (!didScheduleChatBadgeBackfill) {
        didScheduleChatBadgeBackfill = true;
        // Background trickle deriving chatBadges for legacy worktrees so the
        // renderer can skip eager transcript hydration for them next launch.
        trackDetachedWork(() =>
          backfillMissingWorktreeChatBadges(refreshedItems),
        );
      }
      const response = {
        ...refreshed,
        items: refreshedItems,
      };
      if (__CANOPY_E2E__)
        observeFirstProjectsLoadMain(
          observer,
          event,
          'projects-load-main-resolved',
          () => ({
            requestOrdinal,
            ...projectFirstProjectsLoadItems(
              refreshedItems,
              refreshed.warnings,
            ),
          }),
        );
      if (event?.sender)
        deliveredSidebarItems.set(event.sender, response.items);
      return response;
    } catch (error) {
      const legacyError =
        error instanceof CanopyOperationError &&
        error.runtimeCause instanceof Error
          ? error.runtimeCause
          : error;
      if (__CANOPY_E2E__)
        observeFirstProjectsLoadMain(
          observer,
          event,
          'projects-load-main-rejected',
          () => ({
            requestOrdinal,
            ...classifyFirstProjectsLoadError(legacyError),
          }),
        );
      throw legacyError;
    }
  });

  const metadataCommands = (
    event: IpcMainInvokeEvent,
  ): ProjectedWorkspaceMetadataCommands =>
    projectedWorkspaceMetadataCommands({
      dispatcher,
      caller: resolveCaller(event),
    });
  const guardedCommands = (
    event: IpcMainInvokeEvent,
  ): ProjectedWorkspaceGuardedCommands =>
    projectedWorkspaceGuardedCommands({
      dispatcher,
      caller: resolveCaller(event),
    });

  registerIpcHandler(
    IPC_CHANNELS.workspaceUpdateMetadata,
    async (event, request: UpdateWorkspaceMetadataRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      await metadataCommands(event).updateMetadata({
        workspaceId: request.workspaceId,
        patch: {
          name: request.name,
          color: request.color,
          pinned: request.pinned,
          itemSortMode: request.itemSortMode,
        },
        source: 'desktop_canopy_client',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceReorder,
    async (event, request: ReorderWorkspacesRequest): Promise<void> => {
      validateId(request.activeWorkspaceId, 'activeWorkspaceId');
      validateId(request.overWorkspaceId, 'overWorkspaceId');
      const [{ items }, preferences] = await settleAll([
        readAllSidebarItems(),
        readPreferencesFile(),
      ]);
      const hiddenWorkspaceIds = new Set(
        preferences.worktreeFilterHiddenWorkspaceIds ?? [],
      );
      const visibleWorkspaceIds = items
        .filter((item) => {
          if (hiddenWorkspaceIds.has(item.id)) return false;
          if (item.alwaysShow !== false) return true;
          return hasVisibleWorkspaceContent(item);
        })
        .map((item) => item.id);
      await metadataCommands(event).reorder({
        visibleWorkspaceIds,
        activeWorkspaceId: request.activeWorkspaceId,
        overWorkspaceId: request.overWorkspaceId,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetTrackedBaseBranch,
    async (event, request: SetTrackedBaseBranchRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      // Source-backed workspaces address the workspace root through the
      // synthetic `WORKSPACE_ROOT_REPO_ID`, which is not a plain slug.
      validateOptionalRepoId(request.repoId, 'repoId');
      // `null` is a deliberate clear, not a missing value: the renderer's
      // in-memory clear has to reach disk through this channel too, because a
      // wholesale `saveProjects()` can no longer carry the removal past
      // `preserveMainOwnedWorktreeMetadata`. The `core.worktree.update`
      // boundary persists a scalar clear as `null`, drops a cleared
      // repository's entry, and clears the merge-retarget grouping parent.
      const baseBranch = request.baseBranch;
      try {
        await guardedCommands(event).updateWorktree({
          workspaceId: request.workspaceId,
          worktreeId: request.worktreeId,
          patch:
            request.repoId === undefined
              ? { trackedBaseBranch: baseBranch }
              : { trackedRepoBaseBranches: { [request.repoId]: baseBranch } },
        });
      } catch (error) {
        if (
          error instanceof WorktreeUpdateRefusedError &&
          error.reason === 'not-found'
        ) {
          throw new Error(
            `Worktree "${request.worktreeId}" was not found in project "${request.workspaceId}".`,
          );
        }
        throw error;
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectsSave,
    async (event, items: SidebarItem[], options?: SidebarItemsSaveOptions) => {
      validateSidebarItems(items);
      options?.preserveWorkspaceIds?.forEach((workspaceId) => {
        validateId(workspaceId, 'preserved project id');
      });
      // Resolved before any write, so an untrusted sender changes nothing.
      const commands = metadataCommands(event);
      const worktreeCommands = guardedCommands(event);
      return serializeChatProjectOperation(async () => {
        const previousItems = event?.sender
          ? deliveredSidebarItems.get(event.sender)
          : undefined;
        const result = await saveSidebarItems({
          source: 'projects_save',
          items,
          options,
          previousItems,
          updateWorkspaceMetadata: (update) => commands.updateMetadata(update),
          updateWorktree: (update) => worktreeCommands.updateWorktree(update),
        });
        const preservedWorkspaceIds = getFailedWorkspaceIds(result);
        // The store ignores the save response and retains its submitted view.
        // Keep that view as the next edit baseline, not the newer disk
        // projection, except for workspaces this save preserved: their edits
        // were not applied, so they keep the baseline they were edited from.
        if (event?.sender) {
          const previousById = new Map(
            (previousItems ?? []).map((item) => [item.id, item]),
          );
          deliveredSidebarItems.set(
            event.sender,
            items.flatMap((item) => {
              if (!preservedWorkspaceIds.has(item.id)) return [item];
              const previous = previousById.get(item.id);
              return previous ? [previous] : [];
            }),
          );
        }
        syncTrackedWorkspaces(result.items, preservedWorkspaceIds);
        syncCodeGraphBaseRepositories(result.items, preservedWorkspaceIds);
        publishWorktreeLifecycleChange('projects-saved');
        syncWorktreesFileWatchers(
          result.items,
          getWindow,
          preservedWorkspaceIds,
          reconcileExternalSnapshot,
        );
        recordWorkspaceCrudTelemetry({
          action: 'save',
          source: 'projects_save',
        });
        return result;
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectSaveDefaultPlugins,
    async (event, request: SaveDefaultPluginsRequest) => {
      validateId(request.projectId, 'project id');
      const commands = guardedCommands(event);
      // Ordered with the other project operations, as before; only this
      // project's manifest is written.
      return serializeChatProjectOperation(() =>
        saveDefaultPluginsAndVisibility(request, 'project_settings', (update) =>
          commands.updatePlugins(update),
        ),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectApplySourceChanges,
    async (
      event,
      request: ProjectApplySourceChangesRequest,
    ): Promise<ProjectApplySourceChangesResponse> => {
      validateId(request.projectId, 'projectId');
      if (request.startPage !== undefined) {
        assertStartPageFeatureEnabled();
      }
      if (request.target.mode === 'existing') {
        validateId(request.target.worktreeId, 'worktreeId');
      }

      return projectedSourceCompositionCommands({
        dispatcher,
        caller: resolveCaller(event),
      }).applySourceChanges(request.projectId, request, () =>
        applySourceChanges({
          kind: 'project',
          source: 'project_settings',
          request,
          getWindow,
          onApplied: (applied) => {
            const window = getWindow();
            if (!window) {
              return;
            }
            sendToWindow(
              window,
              IPC_CHANNELS.projectSourceChangesApplied,
              applied,
            );
          },
        }),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.projectDelete,
    async (event, request: DeleteProjectRequest): Promise<void> => {
      validateId(request.projectId, 'projectId');
      if (request.supersedeInterruptedDeletion !== undefined)
        validateId(
          request.supersedeInterruptedDeletion,
          'supersedeInterruptedDeletion',
        );
      // The full workspace deletion (CAN-3799 B6): it refuses anything but a
      // single-repo project and also removes an app-created managed repo.
      const outcome = await projectedWorkspaceLifecycleCommands({
        dispatcher,
        caller: resolveCaller(event),
      }).deleteWorkspace({ workspaceId: request.projectId }, () =>
        deleteWorkspace({
          workspaceId: request.projectId,
          source: 'single_repo_project_delete',
          singleRepoProject: true,
          supersedeInterruptedDeletion: request.supersedeInterruptedDeletion,
        }),
      );
      // This channel has always failed when the managed repository could not
      // be removed; keep that visible although the project itself is gone.
      const repository = outcome.cleanup.managedRepository;
      if (repository.status === 'failed') {
        throw repository.error instanceof Error
          ? repository.error
          : new Error(String(repository.error));
      }
    },
  );
}
