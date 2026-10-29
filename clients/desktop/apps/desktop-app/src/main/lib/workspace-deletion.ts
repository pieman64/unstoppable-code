import {
  assertNoDestructiveRecovery,
  withDestructiveLifecycle,
  destructiveStep,
  markDestructiveCleanupRequired,
  destructiveCleanup,
  protectDestructivePath,
  retryDeletedWorkspaceSearchCleanup,
} from './w5-destructive-recovery';
import { z } from 'zod';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  withW5Commit,
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import { rm } from 'node:fs/promises';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import {
  COWORK_HOME_WORKTREE_ID,
  isDefaultCoworkWorkspaceId,
  type ArchivedContainerManifest,
  type ArchivedGitState,
  type SidebarItem,
  type SidebarItemsFile,
} from '@canopy/desktop-shared/types';
import {
  assertNoLiveDelegationsInWorkspace,
  LiveDelegationsError,
} from '../agents/delegation/activity';
import { destroyWorktreeSessions } from '../agents/session-manager';
import {
  captureLedgerWorkspaceIncarnations,
  notifyLedgerWorkspaceDeleted,
  type LedgerWorkspaceCapture,
} from '../ledger/lifecycle';
import { listWorkEntryIds } from './cowork-work-entries';
import { deleteCoworkWorkspace } from './cowork-workspace-crud';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import {
  getWorkspaceIndexFilePath,
  getDefaultReposDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
} from './paths';
import { isPathInside } from './path-safety';
import { cleanupUnreferencedRepoShadows } from './repo-shadow';
import { syncCodeGraphBaseRepositories } from './code-graph-base-manager';
import {
  cancelCodeGraphReadsForWorkspace,
  fenceCodeGraphReadsForWorkspace,
} from '../code-graph/read-runner';
import {
  readAllSidebarItems,
  readWorkspaceIndexEntry,
  removeWorkspaceIndexEntry,
  getWorkspaceIndexRepository,
} from './sidebar-items';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { validateId } from './validation';
import { getChatSearchService } from '../chat-search/service';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import {
  acquireWorkspaceDeletionLease,
  SplitLockError,
} from '../services/split-lock-service';
import { projectPluginDefaultsWritten } from '../plugins/project-plugin-defaults-cache';
import {
  listArchivedContainerManifestsStrict,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import {
  readArchivedGitStagedDescriptor,
  releaseArchivedGitState,
} from './archived-container-git';
import { finishArchivedContainerRecovery } from './archived-container-recovery';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import {
  archiveWorkspaceWorktrees,
  WorktreeArchiveRefusedError,
} from './worktree-archive';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const cleanupReceiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done') }),
  z.object({ status: z.literal('skipped') }),
  z.object({
    status: z.literal('failed'),
    error: z.unknown().transform(() => ({ name: 'Error' })),
  }),
]);
const workspaceDeletionReceiptSchema = z.object({
  workspaceId: z.string(),
  removed: z.enum(['cowork', 'unindexed', 'code']),
  cleanup: z.object({
    archivedGitRefs: cleanupReceiptSchema,
    chatSearchRows: cleanupReceiptSchema,
    managedRepository: cleanupReceiptSchema,
    // Receipts recorded before CAN-385 have no skill suggestion step.
    skillSuggestions: cleanupReceiptSchema.default({ status: 'skipped' }),
  }),
});

/** The caller of a deletion, recorded in workspace CRUD telemetry. */
export type WorkspaceDeletionSource =
  | 'multi_repo_workspace_delete'
  | 'single_repo_project_delete'
  | 'portal'
  | 'org-member-multi-repo-create'
  | 'shared_container_fork';

export interface WorkspaceDeletionRequest extends W5BoundaryOptions {
  workspaceId: string;
  source: WorkspaceDeletionSource;
  /**
   * The single-repo project deletion (`project:delete`, CAN-3799 B6): refuse
   * any other kind of project, refuse while its configuration is unreadable,
   * and also remove its repository when the app created it under the managed
   * repos directory. A user's repository is never deleted.
   */
  singleRepoProject?: boolean;
}

/** One cleanup step that runs after the deletion has committed. */
export type WorkspaceCleanupResult =
  | { status: 'done' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown };

export interface WorkspaceDeletionOutcome {
  workspaceId: string;
  /** What the deletion removed; `unindexed` when no index entry existed. */
  removed: 'cowork' | 'code' | 'unindexed';
  /**
   * Post-commit cleanup. A failed step never fails the committed deletion,
   * so callers see it here (each failure is also logged).
   */
  cleanup: {
    archivedGitRefs: WorkspaceCleanupResult;
    chatSearchRows: WorkspaceCleanupResult;
    managedRepository: WorkspaceCleanupResult;
    /** Repeat-task skill suggestion fingerprints and private suggestions. */
    skillSuggestions: WorkspaceCleanupResult;
  };
}

export type WorkspaceDeletionRefusal =
  | 'protected'
  | 'configuration-unavailable'
  | 'not-single-repo'
  | 'git-cleanup-pending';

/** An admission check refused the deletion before anything was removed. */
export class WorkspaceDeletionRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceDeletionRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceDeletionRefusedError';
  }
}

/**
 * The typed in-process workspace deletion boundary (CAN-3809). Every
 * deletion of a whole workspace goes through it: the renderer
 * (`workspace:delete`, `project:delete`), the browser Remote Control portal
 * (`portal.workspace.delete`) and rollbacks of org project creation and
 * shared-container forks, so the surfaces cannot drift on how a workspace is
 * torn down. Admission checks run before anything destructive; a failure
 * before the index commit leaves the workspace and its retained archives
 * recoverable. Optional revisions guard admission and index removal; keyed
 * attempts retain their reservation until final cleanup returns (CAN-3805).
 *
 * Cowork workspaces route through the dedicated delete/detach logic
 * (`destroyWorktreeSessions` + `deleteCoworkWorkspace`) so observability,
 * browser, and attachment cleanup fire, and so an external
 * (`externalPath`-backed) workspace is detached rather than having its attached
 * folder mistaken for Canopy-owned data. All other workspace types remove the
 * top-level sidebar entry first, then remove the persisted workspace directory
 * (worktree checkouts, chats, summaries). The explicit index deletion bypasses
 * transient-load preservation for only the requested workspace id.
 *
 * `telemetrySource` distinguishes the caller (e.g. `multi_repo_workspace_delete`
 * for the renderer, `portal` for the browser Remote Control) in CRUD telemetry.
 */
export async function deleteWorkspace(
  request: WorkspaceDeletionRequest,
): Promise<WorkspaceDeletionOutcome> {
  const { workspaceId } = request;
  validateId(workspaceId, 'workspaceId');
  if (isDefaultCoworkWorkspaceId(workspaceId)) {
    throw new WorkspaceDeletionRefusedError(
      'protected',
      // Straight from the shared label rather than via
      // `cowork-workspace-crud`, which consumers of this module mock.
      `The ${CHAT_UNIT_LABEL_PLURAL} project cannot be deleted`,
    );
  }
  const { expectedRevision, idempotencyKey, ...parameters } = request;
  return runW5BoundaryOperation(
    {
      operation: 'core.workspace.delete',
      caller: `desktop-host:${request.source}`,
      idempotencyKey,
      parameters,
      isPreEffectRefusal: (error) =>
        error instanceof WorkspaceDeletionRefusedError ||
        error instanceof WorktreeArchiveRefusedError ||
        error instanceof LiveDelegationsError ||
        error instanceof SplitLockError ||
        error instanceof W5RevisionConflictError,
    },
    (outcome) => workspaceDeletionReceiptSchema.parse(outcome),
    (options, attempt) =>
      serializeWorkspaceMutation(async () => {
        await checkW5ExpectedRevision(
          { kind: 'workspace', workspaceId },
          expectedRevision,
        );
        await assertNoDestructiveRecovery(workspaceId);
        return withDestructiveLifecycle(
          {
            operation: 'workspace-delete',
            workspaceId,
            beforeEffects: attempt?.beforeEffects,
            projectOutcome: (result) =>
              workspaceDeletionReceiptSchema.parse(result),
          },
          async () => {
            const outcome = await deleteWorkspaceSerialized(
              request,
              options,
              attempt,
            );
            if (
              Object.values(outcome.cleanup).some(
                (step) => step.status === 'failed',
              )
            )
              markDestructiveCleanupRequired();
            return outcome;
          },
        );
      }),
  );
}

/** {@link deleteWorkspace} for callers that only need it to finish. */
export async function deleteWorkspaceById(
  workspaceId: string,
  source: WorkspaceDeletionSource,
): Promise<void> {
  await deleteWorkspace({ workspaceId, source });
}

/** Host-only manual repair; never repeats canonical deletion, Git or directory removal. */
export async function retryWorkspaceDeletionSearchCleanup(request: {
  source: 'manual_repair';
  workspaceId: string;
  operationId: string;
}): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  await serializeWorkspaceMutation(() =>
    withArchivedWorkspaceOperationLock(request.workspaceId, async () => {
      const index = await getWorkspaceIndexRepository().read();
      if (
        (index.authority !== 'ok' && index.authority !== 'absent') ||
        index.entries.some((entry) => entry.id === request.workspaceId)
      )
        throw new WorkspaceDeletionRefusedError(
          'configuration-unavailable',
          'Cannot verify that this project was deleted. Inspect its index before retrying cleanup.',
        );
      await retryDeletedWorkspaceSearchCleanup(
        request.workspaceId,
        request.operationId,
        () => getChatSearchService().deleteWorkspaceDocs(request.workspaceId),
      );
    }),
  );
}

async function deleteWorkspaceSerialized(
  request: WorkspaceDeletionRequest,
  options: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<WorkspaceDeletionOutcome> {
  const { workspaceId } = request;
  // Read-only admission refusals release a keyed reservation for a retry.
  const admit = (check: () => void): void =>
    attempt ? attempt.validate(check) : check();
  // In-app deletion is refused while any chat in the workspace has queued,
  // starting or running delegates; the user stops them first.
  admit(() => assertNoLiveDelegationsInWorkspace(workspaceId));
  // Defer the scheduler-backed service until a workspace deletion is actually
  // requested; ordinary workspace reads do not need watcher lifecycle state.
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  let releaseDeletionLease = (): void => {};
  admit(() => {
    releaseDeletionLease = acquireWorkspaceDeletionLease(workspaceId);
  });
  let workspaceRemoved = false;
  try {
    // Read-only admission precedes watcher cancellation and child archives.
    const deletionTarget = await readDeletionTarget(request);
    await getAppAdvisorWatcherService().cancelLocalWorkspace(workspaceId);
    if (USER_DELETION_SOURCES.has(request.source)) {
      // Every client gets the cleanup of an archive from the app (CAN-3799
      // B2): teardown scripts, live sessions and Git worktree registrations.
      // The app's own deletion archives first, so this finds what is left,
      // such as a deletion from the Portal. Admission runs first, and the
      // archives run before the archive lock: each drains the worktree's
      // activity, and an activity touch waits for that lock.
      const { kind } = deletionTarget;
      if (kind === 'single-repo' || kind === 'multi-repo') {
        await archiveWorkspaceWorktrees(workspaceId, kind);
      }
    }
    const outcome = await withArchivedWorkspaceOperationLock(workspaceId, () =>
      deleteWorkspaceWithLease(request, options),
    );
    workspaceRemoved = true;
    await getAppAdvisorWatcherService().commitLocalWorkspaceCancellation(
      workspaceId,
    );
    return outcome;
  } catch (error) {
    if (!workspaceRemoved) {
      await getAppAdvisorWatcherService().releaseLocalWorkspaceFence(
        workspaceId,
      );
    }
    throw error;
  } finally {
    releaseDeletionLease();
  }
}

/**
 * What the Ledger must retire once the workspace is gone: every incarnation
 * the workspace holds, read before the deletion. Reads only when the Ledger
 * database exists, waits a bounded time, and never fails the deletion.
 */
async function captureLedgerContents(
  workspaceId: string,
  archivedManifests: readonly ArchivedContainerManifest[],
): Promise<LedgerWorkspaceCapture | null> {
  try {
    return await captureLedgerWorkspaceIncarnations(
      workspaceId,
      archivedManifests,
    );
  } catch {
    // Startup reconciliation retires the scopes of a deleted workspace.
    return null;
  }
}

/**
 * Tells the Ledger that the captured workspace was deleted, so its scopes
 * retire unless their containers moved elsewhere first. Call only after the
 * deletion commits. The participant returns at once and never throws.
 */
function notifyLedgerOfWorkspaceDeletion(
  capture: LedgerWorkspaceCapture | null,
): void {
  try {
    notifyLedgerWorkspaceDeleted(capture);
  } catch {
    // A defect in the participant must not fail a committed deletion;
    // startup reconciliation settles the scopes.
  }
}

/**
 * The admission checks of a single-repo project deletion, run before
 * anything destructive. Returns the repository to remove after the commit
 * when the app created it under the managed repos directory.
 */
/**
 * The deletions a user asked for, which archive the project's worktrees first
 * (CAN-3799 B2). A rollback removes a project its own operation just created,
 * whose scripts never had the user's consent to run.
 */
const USER_DELETION_SOURCES: ReadonlySet<WorkspaceDeletionSource> =
  new Set<WorkspaceDeletionSource>([
    'multi_repo_workspace_delete',
    'single_repo_project_delete',
    'portal',
  ]);

/** Read what the deletion removes and run its admission checks. */
async function readDeletionTarget(request: WorkspaceDeletionRequest): Promise<{
  sidebarItems: SidebarItemsFile;
  kind: SidebarItem['type'] | undefined;
  managedRepoPath: string | undefined;
}> {
  const { workspaceId } = request;
  const [indexEntry, sidebarItems] = await settleAll([
    readWorkspaceIndexEntry(workspaceId),
    readAllSidebarItems({ persistRemovalCleanup: false }),
  ]);
  const target = sidebarItems.items.find((item) => item.id === workspaceId);
  const kind = target?.type ?? indexEntry?.type;
  const managedRepoPath = request.singleRepoProject
    ? admitSingleRepoProjectDeletion(workspaceId, sidebarItems, target, kind)
    : undefined;
  return { sidebarItems, kind, managedRepoPath };
}

function admitSingleRepoProjectDeletion(
  workspaceId: string,
  sidebarItems: SidebarItemsFile,
  target: SidebarItem | undefined,
  kind: SidebarItem['type'] | undefined,
): string | undefined {
  if (getSidebarItemsPreserveWorkspaceIds(sidebarItems).includes(workspaceId)) {
    throw new WorkspaceDeletionRefusedError(
      'configuration-unavailable',
      'Cannot delete this project while its configuration is unavailable. Reload and try again.',
    );
  }
  // An unindexed id keeps its existing outcome: only its data directory goes.
  if (kind !== undefined && kind !== 'single-repo') {
    throw new WorkspaceDeletionRefusedError(
      'not-single-repo',
      'Only a single-repository project can be deleted this way.',
    );
  }
  const reposDir = getDefaultReposDir();
  return target?.type === 'single-repo' &&
    target.repoPath !== reposDir &&
    isPathInside(reposDir, target.repoPath)
    ? target.repoPath
    : undefined;
}

async function removeManagedRepository(
  repoPath: string | undefined,
): Promise<WorkspaceCleanupResult> {
  if (repoPath === undefined) return { status: 'skipped' };
  try {
    await destructiveCleanup('managed-repository-removal', () =>
      rm(repoPath, { recursive: true, force: true }),
    );
    return { status: 'done' };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to remove the managed project repository:', error);
    return { status: 'failed', error };
  }
}

async function deleteWorkspaceWithLease(
  request: WorkspaceDeletionRequest,
  options: W5CommitOptions,
): Promise<WorkspaceDeletionOutcome> {
  const { workspaceId, source: telemetrySource } = request;
  const { kind, managedRepoPath } = await readDeletionTarget(request);
  if (managedRepoPath) await protectDestructivePath(managedRepoPath);
  async function removeDeletedWorkspaceIndexEntry(): Promise<void> {
    await removeWorkspaceIndexEntry(workspaceId);
  }
  const commitIndexRemoval = (): Promise<void> =>
    destructiveStep(
      'canonical-index-removal',
      () =>
        withW5Commit(
          {
            ...options,
            locks: [{ kind: 'index', path: getWorkspaceIndexFilePath() }],
            expectedRevisions: w5ExpectedRevision(
              { kind: 'workspace', workspaceId },
              request.expectedRevision,
            ),
          },
          removeDeletedWorkspaceIndexEntry,
        ),
      true,
    );
  // Capture the retained Git state while manifests are still readable, but do
  // not release any refs until the parent deletion has committed. A failed
  // teardown must leave every retained container recoverable.
  const archivedManifests =
    await listArchivedContainerManifestsStrict(workspaceId);
  const archivedGitStates: ArchivedGitState[] = [];
  for (const manifest of archivedManifests) {
    if (manifest.version === 2) {
      archivedGitStates.push(manifest.gitState);
      continue;
    }
    if (manifest.version === 3) {
      if (manifest.recovery.gitCleanupPending) {
        await destructiveStep('retained-git-cleanup', () =>
          finishArchivedContainerRecovery(manifest),
        );
        if (manifest.recovery.gitCleanupPending) {
          throw new WorkspaceDeletionRefusedError(
            'git-cleanup-pending',
            'Git registration cleanup is still pending. Retry project deletion after the source repository is available.',
          );
        }
      }
      const staged = await readArchivedGitStagedDescriptor(
        workspaceId,
        manifest.id,
      );
      if (staged && staged.repositories.length > 0) {
        archivedGitStates.push({
          version: 1,
          diffFormatVersion: 1,
          repositories: staged.repositories,
        });
      }
    }
  }
  const ledgerContents = await captureLedgerContents(
    workspaceId,
    archivedManifests,
  );
  if (kind === 'cowork') {
    // Live agent sessions key (workspaceId, workEntryId, chatId) — tear down
    // every entry's sessions plus the legacy pre-entry 'home' slot.
    for (const worktreeId of [
      ...(await listWorkEntryIds(workspaceId)),
      COWORK_HOME_WORKTREE_ID,
    ]) {
      await destructiveStep('session-teardown', () =>
        destroyWorktreeSessions(workspaceId, worktreeId),
      );
    }
    await destructiveStep('cowork-deletion', () =>
      deleteCoworkWorkspace(workspaceId, {
        deferLocalWatcherCancellationCommit: true,
        commitIndexRemoval,
      }),
    );
  } else {
    // Defer browser lifecycle/session initialization until the non-cowork
    // deletion path executes; ordinary workspace planning must stay lightweight.
    const {
      prepareWorkspaceBrowserRetirement,
      commitTaskBrowserRetirement,
      abortTaskBrowserRetirement,
    } = await import('../browser/browser-profile-lifecycle');
    const browserRetirements =
      await prepareWorkspaceBrowserRetirement(workspaceId);
    // The project directory holds every worktree's graph.db, and an idle code
    // graph read worker keeps a read-only connection to it for minutes. Stop
    // them all (and refuse new ones) before the sidebar commit, so the rm
    // below cannot fail on an open graph.db (EBUSY/EPERM on Windows) after the
    // project has already left the sidebar.
    const releaseCodeGraphReadFence =
      fenceCodeGraphReadsForWorkspace(workspaceId);
    let ownerCommitted = false;
    try {
      await cancelCodeGraphReadsForWorkspace(workspaceId);
      await commitIndexRemoval();
      ownerCommitted = true;
      for (const entry of browserRetirements)
        await destructiveStep('browser-retirement', () =>
          commitTaskBrowserRetirement(workspaceId, entry.worktreeId),
        );
      await destructiveStep('workspace-directory-removal', () =>
        removeDeletedWorkspaceDirectory(workspaceId),
      );
      projectPluginDefaultsWritten({
        configPath: getWorkspaceConfigPath(workspaceId),
        workspaceId,
        layerChanged: true,
      });
    } catch (error) {
      if (!ownerCommitted)
        for (const entry of browserRetirements)
          await abortTaskBrowserRetirement(entry.operationId);
      throw error;
    } finally {
      releaseCodeGraphReadFence();
    }
  }
  // The deletion has committed: the index entry and the workspace directory,
  // with its Work Entries and archives, are gone.
  notifyLedgerOfWorkspaceDeletion(ledgerContents);
  const managedRepository = await removeManagedRepository(managedRepoPath);
  let archivedGitRefs: WorkspaceCleanupResult = { status: 'done' };
  for (const gitState of archivedGitStates) {
    await destructiveCleanup('archived-git-refs', () =>
      releaseArchivedGitState(gitState),
    ).catch((error: unknown) => {
      // The workspace deletion is already durable. Ref cleanup is best-effort
      // and releaseArchivedGitState re-pins earlier refs on partial failure.
      // eslint-disable-next-line no-console
      console.error(
        'Failed to release archived Git refs after deletion.',
        error,
      );
      if (archivedGitRefs.status === 'done')
        archivedGitRefs = { status: 'failed', error };
    });
  }
  let chatSearchRows: WorkspaceCleanupResult = { status: 'done' };
  try {
    await destructiveCleanup('chat-search-rows', () =>
      getChatSearchService().deleteWorkspaceDocs(workspaceId),
    );
  } catch (error) {
    // The workspace removal is already durable and the index is rebuildable;
    // a failed row cleanup must not turn a successful deletion into an error.
    // eslint-disable-next-line no-console
    console.error('Failed to remove workspace chat search rows:', error);
    chatSearchRows = { status: 'failed', error };
  }
  let skillSuggestions: WorkspaceCleanupResult = { status: 'done' };
  try {
    // Outside the destructive journal: this data is rebuildable, so a failed
    // purge must not leave the deletion marked for manual recovery.
    // Deferred: the suggestion module is only needed after a deletion.
    const { purgeSkillSuggestionsForWorkspace } =
      await import('../skill-suggestions');
    await purgeSkillSuggestionsForWorkspace(workspaceId);
  } catch (error) {
    // Rebuildable local data: a failed purge never fails the deletion.
    // eslint-disable-next-line no-console
    console.error('Failed to remove workspace skill suggestion data:', error);
    skillSuggestions = { status: 'failed', error };
  }
  recordWorkspaceCrudTelemetry({
    action: 'delete',
    workspaceId,
    source: telemetrySource,
  });
  // Deletion removes the workspace directory without rewriting the index (it
  // self-heals on the next read), so the shared index-write hook never fires;
  // push the portal overview refresh explicitly (CAN-1304).
  schedulePortalStructuralSync();

  // Best-effort, non-blocking: reap repo shadows for repos no remaining
  // workspace references. Re-read sidebar items after deletion so the deleted
  // workspace's repos no longer count as referenced.
  try {
    const remainingSidebarItems = await readAllSidebarItems();
    const { items: remainingItems } = remainingSidebarItems;
    syncCodeGraphBaseRepositories(
      remainingItems,
      new Set(getSidebarItemsPreserveWorkspaceIds(remainingSidebarItems)),
    );
    trackDetachedWork(() =>
      cleanupUnreferencedRepoShadows(
        collectReferencedRepoPaths(remainingItems),
      ).catch(() => undefined),
    );
  } catch {
    // Ignore: the workspace is already deleted; shadow reaping is follow-up.
  }
  return {
    workspaceId,
    removed:
      kind === 'cowork' ? 'cowork' : kind === undefined ? 'unindexed' : 'code',
    cleanup: {
      archivedGitRefs,
      chatSearchRows,
      managedRepository,
      skillSuggestions,
    },
  };
}

function collectReferencedRepoPaths(items: SidebarItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.type === 'single-repo') {
      paths.push(item.repoPath);
    } else if (item.type === 'multi-repo') {
      if (item.sourceRepoPath) {
        paths.push(item.sourceRepoPath);
      }
      for (const repo of item.repos) {
        paths.push(repo.repoPath);
      }
    }
  }
  return paths;
}

async function removeDeletedWorkspaceDirectory(
  workspaceId: string,
): Promise<void> {
  await rm(getWorkspaceDir(workspaceId), { recursive: true, force: true });
}
