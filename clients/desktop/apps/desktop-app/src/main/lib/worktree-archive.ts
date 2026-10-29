import {
  assertNoDestructiveRecovery,
  readDestructiveRecovery,
  findCompletedDestructiveArchive,
  destructiveArchiveOutcomeSchema,
} from './w5-destructive-recovery';
import { z } from 'zod';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import { access } from 'node:fs/promises';
import type {
  ArchiveWorktreeResponse,
  ArchivedContainerManifest,
} from '@canopy/desktop-shared/types';
import { assertNoLiveDelegationsInWorktree } from '../agents/delegation/activity';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
} from '../services/split-lock-service';
import { listArchivedContainerManifests } from './archived-containers';
import { recordWorktreeCrudTelemetry } from './desktop-telemetry';
import { queueTrackedGitHubWorktreeSync } from './post-archive-sync';
import { getWorkspaceWorktreeDir } from './paths';
import { validateId } from './validation';
import {
  WorkspaceTargetAutoArchiveExcludedError,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetAutoArchiveTeardown,
} from './workspace-target-exclusion';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
} from './worktree-service';

/** The caller of an archive, recorded in worktree CRUD telemetry. */
export type WorktreeArchiveSource =
  | 'single_repo'
  | 'multi_repo'
  | 'portal'
  | 'workspace_delete';

export interface WorktreeArchiveRequest {
  expectedRevision?: number;
  workspaceId: string;
  worktreeId: string;
  source: WorktreeArchiveSource;
  /** Refuse unless the project is of this kind (the IPC channels are per kind). */
  expectedKind?: 'single-repo' | 'multi-repo';
  /** The incarnation the caller saw; a repeat matches only that one. */
  expectedCreatedAt?: string;
  expectedBranchName?: string;
  deleteBranch?: boolean;
  /** Commit the retained archive with retention locking already enabled. */
  lockAfterArchive?: boolean;
  /** Delete without retention only when the worktree path is missing. */
  deleteWithoutRetentionIfMissing?: boolean;
  remainingWorktreeOrder?: readonly string[];
  expectedRemainingWorktreeOrder?: readonly string[];
  /** Single-repo only: must match the project's repository. */
  repoPath?: string;
  /**
   * Run the configured teardown scripts inside the archive, under an
   * exclusive lease that keeps new runtimes out of the worktree; a failure
   * message names this operation. A worktree already being deleted or
   * starting a runtime is refused as `busy`.
   */
  teardownOperation?: string;
}

export type WorktreeArchiveOutcome = ArchiveWorktreeResponse & {
  /**
   * `already-archived`: the worktree was archived or deleted before, so this
   * call had no effect (CAN-3799 B5).
   */
  status: 'archived' | 'already-archived';
};

export type WorktreeArchiveRefusal =
  | 'unsupported-workspace'
  | 'kind-mismatch'
  | 'not-found'
  | 'busy';

/** An admission check refused the archive before any effect. */
export class WorktreeArchiveRefusedError extends Error {
  constructor(
    readonly reason: WorktreeArchiveRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeArchiveRefusedError';
  }
}

function archivedThisIncarnation(
  manifest: ArchivedContainerManifest,
  worktreeId: string,
  expectedCreatedAt: string | undefined,
): boolean {
  const original = manifest.originalWorktree;
  return (
    original?.id === worktreeId &&
    (expectedCreatedAt === undefined ||
      original.createdAt === expectedCreatedAt)
  );
}

async function checkoutExists(
  workspaceId: string,
  worktreeId: string,
): Promise<boolean> {
  try {
    await access(getWorkspaceWorktreeDir(workspaceId, worktreeId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a worktree that is no longer in the list was archived before: a
 * retained archive holds it, or this process deleted it without retention.
 * Unreadable or incomplete archive directories are skipped.
 */
async function wasArchived(request: WorktreeArchiveRequest): Promise<boolean> {
  if (
    isWorkspaceWorktreeRecentlyRemoved(
      request.workspaceId,
      request.worktreeId,
      request.expectedCreatedAt,
    )
  ) {
    return true;
  }
  const manifests = await listArchivedContainerManifests(request.workspaceId);
  return manifests.some((manifest) =>
    archivedThisIncarnation(
      manifest,
      request.worktreeId,
      request.expectedCreatedAt,
    ),
  );
}

/**
 * Run an archive with the configured teardown scripts, as Auto Delete does:
 * the lease refuses a worktree that is starting a runtime or already being
 * deleted, and keeps new runtimes out until the archive ends, while the
 * teardown it owns may still start its scripts.
 */
async function archiveWithTeardown(
  workspaceId: string,
  worktreeId: string,
  multiRepo: boolean,
  operation: string,
  archive: (
    runAutoArchiveTeardown: () => Promise<void>,
  ) => Promise<ArchiveWorktreeResponse>,
): Promise<ArchiveWorktreeResponse> {
  try {
    return await withWorkspaceTargetAutoArchiveLease(
      workspaceId,
      worktreeId,
      () =>
        archive(() =>
          withWorkspaceTargetAutoArchiveTeardown(
            workspaceId,
            worktreeId,
            async () => {
              // Loaded on use, as Auto Delete does: the script runner is heavy.
              const { runAutoArchiveTeardown } =
                await import('./auto-archive-teardown');
              await runAutoArchiveTeardown(
                workspaceId,
                worktreeId,
                multiRepo,
                operation,
              );
            },
          ),
        ),
    );
  } catch (error) {
    if (error instanceof WorkspaceTargetAutoArchiveExcludedError) {
      throw new WorktreeArchiveRefusedError(
        'busy',
        'A worktree is busy. Retry after it finishes.',
      );
    }
    throw error;
  }
}

/**
 * The typed in-process worktree archive boundary (CAN-3811), behind the
 * renderer's single- and multi-repo archive channels and the Portal's
 * `portal.worktree.archive`. It checks the project kind, the split and
 * delegation safeguards, and whether the worktree still exists before any
 * effect, then runs the desktop archive lifecycle with live cleanup: a
 * retained container unless the caller asked for a deletion without
 * retention. A repeat of a completed archive succeeds with no effect, and an
 * unknown worktree is refused (CAN-3799 B5). An optional row revision applies
 * only to the first transition (CAN-3805); restore stays on the archive.
 */
export function archiveWorktree(
  request: WorktreeArchiveRequest,
): Promise<WorktreeArchiveOutcome> {
  return archiveWorktreeTransition(request, {
    operation: 'core.worktree.archive',
  });
}

/** Explicit keyed deletion uses the same lifecycle, without retaining a container. */
export interface WorktreeDeleteRequest
  extends
    Omit<
      WorktreeArchiveRequest,
      'lockAfterArchive' | 'deleteWithoutRetentionIfMissing'
    >,
    W5BoundaryOptions {}

const archiveOutcomeSchema = destructiveArchiveOutcomeSchema.extend({
  status: z.enum(['archived', 'already-archived']),
});

export async function deleteWorktree(
  request: WorktreeDeleteRequest,
): Promise<WorktreeArchiveOutcome> {
  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  const { expectedRevision, idempotencyKey, ...parameters } = request;
  return runW5BoundaryOperation(
    {
      operation: 'core.worktree.delete',
      caller: `desktop-host:${request.source}`,
      idempotencyKey,
      parameters,
      isPreEffectRefusal: (error) =>
        error instanceof WorktreeArchiveRefusedError ||
        error instanceof W5RevisionConflictError,
    },
    (outcome) => archiveOutcomeSchema.parse(outcome),
    async (options, attempt) => {
      const pending = await readDestructiveRecovery(
        request.workspaceId,
        request.worktreeId,
      );
      if (!pending || pending.state === 'completed') {
        await checkW5ExpectedRevision(
          {
            kind: 'worktree',
            workspaceId: request.workspaceId,
            worktreeId: request.worktreeId,
          },
          expectedRevision,
        );
      }
      return archiveWorktreeTransition(
        { ...parameters, expectedRevision },
        options,
        attempt,
        false,
      );
    },
  );
}

async function archiveWorktreeTransition(
  request: WorktreeArchiveRequest,
  w5Commit: W5CommitOptions,
  attempt?: W5KeyedAttempt,
  retainAsArchivedContainer?: boolean,
): Promise<WorktreeArchiveOutcome> {
  const { workspaceId, worktreeId } = request;
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  for (const order of [
    request.remainingWorktreeOrder,
    request.expectedRemainingWorktreeOrder,
  ]) {
    order?.forEach((id, index) => {
      validateId(id, `worktree order[${index}]`);
    });
  }

  const unfinished = await readDestructiveRecovery(workspaceId, worktreeId);
  const needsCleanupRecovery =
    unfinished !== null && unfinished.state !== 'completed';
  // The locked service validates recovery before any effects; ordinary admission
  // and completed-outcome replay keep the existing refusal behavior.
  if (!needsCleanupRecovery)
    await assertNoDestructiveRecovery(workspaceId, worktreeId);
  const recovery = await findCompletedDestructiveArchive(
    workspaceId,
    worktreeId,
    request.expectedCreatedAt,
  );
  const { config, authority } = await readWorkspaceConfigDetailed(workspaceId);
  // An unreadable config reads as a default multi-repo one, so only an
  // authoritative read decides the kind; otherwise the caller's channel does,
  // and the archive lifecycle reports the unreadable config itself.
  const kind =
    authority === 'ok' ? config.type : (request.expectedKind ?? config.type);
  if (kind === 'cowork') {
    throw new WorktreeArchiveRefusedError(
      'unsupported-workspace',
      'Cannot archive a worktree in a cowork project.',
    );
  }
  if (request.expectedKind !== undefined && kind !== request.expectedKind) {
    throw new WorktreeArchiveRefusedError(
      'kind-mismatch',
      'Cannot archive the worktree because the project is not the expected kind.',
    );
  }
  const rows =
    request.expectedRevision === undefined && !needsCleanupRecovery
      ? await readWorkspaceWorktrees(workspaceId)
      : await readWorkspaceWorktrees(workspaceId, {
          persistRemovalCleanup: false,
        });
  const current = rows.find((worktree) => worktree.id === worktreeId);
  if (!current && !needsCleanupRecovery) {
    // A row can leave the list while its checkout stays, as a needs-repair
    // rollback does; the archive lifecycle still tears that checkout down.
    if (!(await checkoutExists(workspaceId, worktreeId))) {
      if (recovery || (await wasArchived(request))) {
        return {
          ...(recovery?.state === 'completed'
            ? archiveOutcomeSchema.parse({
                ...destructiveArchiveOutcomeSchema.parse(recovery.outcome),
                status: 'already-archived',
              })
            : { success: true, warnings: [] }),
          status: 'already-archived',
        };
      }
      throw new WorktreeArchiveRefusedError('not-found', 'Worktree not found.');
    }
  } else if (
    request.expectedCreatedAt !== undefined &&
    current?.createdAt !== request.expectedCreatedAt &&
    !needsCleanupRecovery &&
    (recovery || (await wasArchived(request)))
  ) {
    // The caller's incarnation is archived; a newer one under the same id is
    // left alone.
    return {
      ...(recovery?.state === 'completed'
        ? archiveOutcomeSchema.parse({
            ...destructiveArchiveOutcomeSchema.parse(recovery.outcome),
            status: 'already-archived',
          })
        : { success: true, warnings: [] }),
      status: 'already-archived',
    };
  }

  if (
    current &&
    request.expectedCreatedAt !== undefined &&
    current.createdAt !== request.expectedCreatedAt
  ) {
    throw new WorktreeArchiveRefusedError(
      'not-found',
      `Worktree ${worktreeId} changed after archive was requested`,
    );
  }

  // The guards apply only to a call that runs the archive lifecycle: a retry
  // for an archived incarnation has no effect, whatever a newer one is doing.
  // Split PR lockdown: removing the checkout under a running or review-phase
  // split would strand the split map and its branches.
  // Read-only refusals release a keyed reservation for a retry.
  const admit = (check: () => void): void =>
    attempt ? attempt.validate(check) : check();
  admit(() => {
    assertNotSplitLocked(workspaceId, worktreeId, 'archiving the worktree');
    assertNotSplitDestinationWorktreeClaimed(
      workspaceId,
      worktreeId,
      'archiving the worktree',
    );
    // A chat with live delegates keeps its worktree (the row shows working).
    assertNoLiveDelegationsInWorktree(workspaceId, worktreeId);
  });

  // Archive journals may advance the row during teardown. The caller revision
  // guards the first transition, before those internal operations and effects.
  if (!needsCleanupRecovery)
    await checkW5ExpectedRevision(
      { kind: 'worktree', workspaceId, worktreeId },
      request.expectedRevision,
    );
  const options = {
    w5Commit: {
      ...w5Commit,
      expectedRevisions: w5ExpectedRevision(
        { kind: 'worktree', workspaceId, worktreeId },
        needsCleanupRecovery ? undefined : request.expectedRevision,
      ),
    },
    ...(retainAsArchivedContainer === undefined
      ? {}
      : { retainAsArchivedContainer }),
    workspaceId,
    worktreeId,
    expectedCreatedAt: request.expectedCreatedAt ?? current?.createdAt,
    ...(request.expectedBranchName !== undefined
      ? { expectedBranchName: request.expectedBranchName }
      : {}),
    ...(request.deleteBranch !== undefined
      ? { deleteBranch: request.deleteBranch }
      : {}),
    ...(request.lockAfterArchive !== undefined
      ? { lockAfterArchive: request.lockAfterArchive }
      : {}),
    ...(request.deleteWithoutRetentionIfMissing !== undefined
      ? {
          deleteWithoutRetentionIfMissing:
            request.deleteWithoutRetentionIfMissing,
        }
      : {}),
    ...(request.remainingWorktreeOrder !== undefined
      ? { remainingWorktreeOrder: request.remainingWorktreeOrder }
      : {}),
    ...(request.expectedRemainingWorktreeOrder !== undefined
      ? {
          expectedRemainingWorktreeOrder:
            request.expectedRemainingWorktreeOrder,
        }
      : {}),
    observabilityMode: 'live-service' as const,
    liveServices: {
      cleanupLiveState: cleanupLiveWorktreeState,
      purgeObservabilityData: purgeLiveWorktreeObservabilityData,
    },
  };
  const archive = (
    runAutoArchiveTeardown?: () => Promise<void>,
  ): Promise<ArchiveWorktreeResponse> => {
    // After the teardown lease is admitted: a busy refusal touches nothing.
    const teardown = runAutoArchiveTeardown ? { runAutoArchiveTeardown } : {};
    return kind === 'multi-repo'
      ? archiveMultiRepoWorktree({ ...options, ...teardown })
      : archiveSingleRepoWorktree({
          ...options,
          ...teardown,
          ...(request.repoPath !== undefined
            ? { repoPath: request.repoPath }
            : {}),
        });
  };
  const { teardownOperation } = request;
  const response =
    teardownOperation === undefined
      ? await archive()
      : await archiveWithTeardown(
          workspaceId,
          worktreeId,
          kind === 'multi-repo',
          teardownOperation,
          archive,
        );
  queueTrackedGitHubWorktreeSync();
  recordWorktreeCrudTelemetry({
    action: 'archive',
    workspaceId,
    source: request.source,
  });
  return { status: 'archived', ...response };
}

/**
 * Archive every worktree still in a code project's list before the project is
 * deleted (CAN-3799 B2), with its teardown scripts, live cleanup and a
 * retained archive, as an archive from the app does. A failure stops the
 * deletion before anything else is removed; worktrees archived before it stay
 * restorable. A worktree that left the list meanwhile is skipped.
 */
export async function archiveWorkspaceWorktrees(
  workspaceId: string,
  kind: 'single-repo' | 'multi-repo',
): Promise<void> {
  for (const worktree of await readWorkspaceWorktrees(workspaceId)) {
    try {
      await archiveWorktree({
        workspaceId,
        worktreeId: worktree.id,
        source: 'workspace_delete',
        expectedKind: kind,
        expectedCreatedAt: worktree.createdAt,
        teardownOperation: 'Project deletion',
      });
    } catch (error) {
      if (
        error instanceof WorktreeArchiveRefusedError &&
        error.reason === 'not-found'
      ) {
        continue;
      }
      throw error;
    }
  }
}
