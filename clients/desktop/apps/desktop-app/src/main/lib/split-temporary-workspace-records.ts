import { rm } from 'node:fs/promises';
import type { WorktreeHealthIssue } from '@canopy/desktop-shared/types';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import {
  getWorkspaceDir,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from './paths';
import { withW5RepositoryLocks } from './w5-repository-locks';
import type { W5CommitOptions } from './w5-commit-scope';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';
import { IdentifierValidationError, validateId } from './validation';
import { WorkspaceIndexUnreadableError } from './workspace-index-repository';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import { updateWorkspaceWorktrees } from './workspace-persistence';

/** CAN-3823 part B: in-process split records; checkout and item moves stay with the caller. */
export type SplitRecordSource = 'temporary_split';
export {
  SplitRecordRefusedError,
  type SplitRecordRefusal,
} from './worktree-record-decision-apply';
export type { SplitDestinationRow } from './worktree-record-decisions';
import {
  SplitRecordRefusedError,
  splitReservationNotFound,
} from './worktree-record-decision-apply';
import type { SplitDestinationRow } from './worktree-record-decisions';
import {
  applyWorktreeListUpdate,
  applyWorktreeListRemoval,
  applyWorkspaceIndexRemoval,
} from './workspace-record-decision-port';

export interface SplitRecordIdentity {
  source: SplitRecordSource;
  workspaceId: string;
  worktreeId: string;
  createdAt: string;
}

const EXISTING_LIST = {
  requireAuthoritativeRead: true,
  requireExistingList: true,
} as const;

function admit(request: {
  source: SplitRecordSource;
  workspaceId: string;
  worktreeId?: string;
  createdAt?: string;
}): void {
  if (request.source !== 'temporary_split')
    throw new SplitRecordRefusedError(
      'invalid-request',
      'Unknown split record source',
    );
  try {
    validateId(request.workspaceId, 'workspaceId');
    if (request.worktreeId !== undefined)
      validateId(request.worktreeId, 'worktreeId');
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      throw new SplitRecordRefusedError('invalid-request', error.message);
    throw error;
  }
  if (request.createdAt !== undefined && !request.createdAt.trim())
    throw new SplitRecordRefusedError(
      'invalid-request',
      'A split record needs the source createdAt',
    );
}

function translateRefusal(error: unknown): never {
  if (error instanceof WorktreeRegistryUnreadableError)
    throw new SplitRecordRefusedError('worktrees-unavailable', error.message);
  if (error instanceof WorkspaceIndexUnreadableError)
    throw new SplitRecordRefusedError('index-unavailable', error.message);
  throw error;
}

/** Called under the destination allocation lock; the list lock proves the id is free. */
async function stageSplitDestinationReservation(request: {
  source: SplitRecordSource;
  workspaceId: string;
  worktree: SplitDestinationRow;
}): Promise<void> {
  const identity = {
    ...request,
    worktreeId: request.worktree.id,
    createdAt: request.worktree.createdAt,
  };
  admit(identity);
  try {
    const { worktrees: persisted } = await applyWorktreeListUpdate(
      request.workspaceId,
      { kind: 'split.destination.reserve', worktree: request.worktree },
      EXISTING_LIST,
    );
    if (
      !persisted.some(
        (row) =>
          row.id === identity.worktreeId &&
          row.createdAt === identity.createdAt,
      )
    ) {
      throw splitReservationNotFound(request.workspaceId, identity.worktreeId);
    }
  } catch (error) {
    translateRefusal(error);
  }
}

export function reserveSplitDestinationRecord(
  request: {
    source: SplitRecordSource;
    workspaceId: string;
    worktree: SplitDestinationRow;
  },
  commit?: W5CommitOptions,
): Promise<void> {
  return commitW5BoundaryStep(
    commit,
    commit ? w5CompositionLocks({ lists: [request.workspaceId] }) : [],
    () => stageSplitDestinationReservation(request),
  );
}

/** Undo only the reservation incarnation this split wrote, keeping replacement rows. */
export async function removeSplitDestinationRecord(
  request: SplitRecordIdentity,
): Promise<void> {
  admit(request);
  try {
    await applyWorktreeListRemoval(
      request.workspaceId,
      {
        kind: 'split.destination.remove',
        worktree: { id: request.worktreeId, createdAt: request.createdAt },
      },
      EXISTING_LIST,
    );
  } catch (error) {
    translateRefusal(error);
  }
}

/** Expose retained data after incomplete rollback, creating only this split's recovery row. */
export async function markSplitRecoveryRecord(
  request: SplitRecordIdentity & {
    fallbackWorktree: SplitDestinationRow;
    healthIssue: WorktreeHealthIssue;
  },
): Promise<void> {
  admit(request);
  if (
    request.fallbackWorktree.id !== request.worktreeId ||
    request.fallbackWorktree.createdAt !== request.createdAt
  ) {
    throw new SplitRecordRefusedError(
      'invalid-request',
      'A split recovery row needs the reservation identity',
    );
  }
  try {
    const { worktrees: persisted } = await applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'split.destination.recovery',
        worktree: { id: request.worktreeId, createdAt: request.createdAt },
        fallbackWorktree: request.fallbackWorktree,
        healthIssue: request.healthIssue,
      },
      EXISTING_LIST,
    );
    if (
      !persisted.some(
        (row) =>
          row.id === request.worktreeId && row.createdAt === request.createdAt,
      )
    ) {
      throw splitReservationNotFound(request.workspaceId, request.worktreeId);
    }
  } catch (error) {
    translateRefusal(error);
  }
}

/** Publish a moved checkout only while this split still owns the destination incarnation. */
export async function promoteSplitDestinationRecord(
  request: SplitRecordIdentity & { branchName: string },
): Promise<void> {
  admit(request);
  try {
    await applyWorktreeListUpdate(
      request.workspaceId,
      {
        kind: 'split.destination.promote',
        worktree: { id: request.worktreeId, createdAt: request.createdAt },
        branchName: request.branchName,
      },
      EXISTING_LIST,
    );
  } catch (error) {
    translateRefusal(error);
  }
}

/** The moved archive candidate, or the surviving checkout after a failed archive. */
export async function recordSplitArchiveDestination(request: {
  source: SplitRecordSource;
  workspaceId: string;
  worktree: SplitDestinationRow;
}): Promise<void> {
  const identity = {
    ...request,
    worktreeId: request.worktree.id,
    createdAt: request.worktree.createdAt,
  };
  admit(identity);
  try {
    const { worktrees: persisted } = await applyWorktreeListUpdate(
      request.workspaceId,
      { kind: 'split.destination.archive', worktree: request.worktree },
      EXISTING_LIST,
    );
    if (
      !persisted.some(
        (row) =>
          row.id === identity.worktreeId &&
          row.createdAt === identity.createdAt,
      )
    ) {
      throw splitReservationNotFound(request.workspaceId, identity.worktreeId);
    }
  } catch (error) {
    translateRefusal(error);
  }
}

/**
 * Called under the existing allocation/creation locks. Keep the list lock through
 * the emptiness decision, index removal and file cleanup. No multi-file atomicity
 * is implied: a crash after index removal still leaves the old cleanup gap.
 */
export async function removeSplitCreatedWorkspace(request: {
  source: SplitRecordSource;
  workspaceId: string;
  worktreeIds: readonly string[];
  containsRollbackData: () => Promise<boolean>;
}): Promise<boolean> {
  admit(request);
  request.worktreeIds.forEach((id) => admit({ ...request, worktreeId: id }));
  let removed = false;
  try {
    await withW5RepositoryLocks(
      [
        { kind: 'index', path: getWorkspaceIndexFilePath() },
        {
          kind: 'list',
          path: getWorkspaceWorktreesFilePath(request.workspaceId),
        },
      ],
      () =>
        updateWorkspaceWorktrees(
          request.workspaceId,
          async (rows) => {
            if (rows.length > 0 || (await request.containsRollbackData()))
              return rows;
            await applyWorkspaceIndexRemoval(request.workspaceId, {
              kind: 'split.created-workspace.cleanup',
            });
            for (const worktreeId of request.worktreeIds) {
              await removePersistedWorktreeDataDirectory(
                request.workspaceId,
                worktreeId,
                { removeTree: removeTreeWithoutAsar },
              );
            }
            await rm(getWorkspaceDir(request.workspaceId), {
              recursive: true,
              force: true,
            });
            removed = true;
            return rows;
          },
          { ...EXISTING_LIST, shouldWrite: (): boolean => false },
        ),
    );
  } catch (error) {
    translateRefusal(error);
  }
  return removed;
}
