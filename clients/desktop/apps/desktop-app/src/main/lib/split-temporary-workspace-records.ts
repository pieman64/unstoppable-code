import { rm } from 'node:fs/promises';
import type {
  WorktreeData,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
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
import { removeWorkspaceIndexEntry } from './sidebar-items';
import { IdentifierValidationError, validateId } from './validation';
import { WorkspaceIndexUnreadableError } from './workspace-index-repository';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from './workspace-persistence';

/** CAN-3823 part B: in-process split records; checkout and item moves stay with the caller. */
export type SplitRecordSource = 'temporary_split';
export type SplitRecordRefusal =
  | 'invalid-request'
  | 'identity-changed'
  | 'not-found'
  | 'worktrees-unavailable'
  | 'index-unavailable';

export class SplitRecordRefusedError extends Error {
  constructor(
    readonly reason: SplitRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'SplitRecordRefusedError';
  }
}

/** Fields allocated from the source for a destination reservation or archive candidate. */
export type SplitDestinationRow = Pick<
  WorktreeData,
  | 'id'
  | 'createdAt'
  | 'branchName'
  | 'label'
  | 'status'
  | 'trackedBaseBranch'
  | 'setupPhase'
  | 'splitRecoveryRequired'
  | 'hidden'
>;

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

function assertIdentity(request: SplitRecordIdentity, row: WorktreeData): void {
  if (row.createdAt !== request.createdAt)
    throw new SplitRecordRefusedError(
      'identity-changed',
      `Destination worktree id "${request.worktreeId}" is already reserved.`,
    );
}

function assertNotRemoved(request: SplitRecordIdentity): void {
  if (
    isWorkspaceWorktreeRecentlyRemoved(
      request.workspaceId,
      request.worktreeId,
      request.createdAt,
    )
  ) {
    throw new SplitRecordRefusedError(
      'not-found',
      `Split destination reservation ${request.workspaceId}/${request.worktreeId} disappeared before promotion.`,
    );
  }
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
    const persisted = await updateWorkspaceWorktrees(
      request.workspaceId,
      (rows) => {
        const existing = rows.find((row) => row.id === identity.worktreeId);
        if (existing) {
          assertIdentity(identity, existing);
          return rows;
        }
        assertNotRemoved(identity);
        return [...rows, request.worktree];
      },
      EXISTING_LIST,
    );
    if (
      !persisted.some(
        (row) =>
          row.id === identity.worktreeId &&
          row.createdAt === identity.createdAt,
      )
    ) {
      throw new SplitRecordRefusedError(
        'not-found',
        `Split destination reservation ${request.workspaceId}/${identity.worktreeId} disappeared before promotion.`,
      );
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
    await removeWorkspaceWorktrees(
      request.workspaceId,
      (row) =>
        row.id === request.worktreeId && row.createdAt === request.createdAt,
      undefined,
      undefined,
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
    const persisted = await updateWorkspaceWorktrees(
      request.workspaceId,
      (rows) => {
        const current = rows.find((row) => row.id === request.worktreeId);
        if (current) assertIdentity(request, current);
        else assertNotRemoved(request);
        const recovered: WorktreeData = {
          ...(current ?? request.fallbackWorktree),
          splitRecoveryRequired: true,
          healthIssue: request.healthIssue,
        };
        delete recovered.hidden;
        recovered.setupPhase = undefined;
        return current
          ? rows.map((row) => (row === current ? recovered : row))
          : [...rows, recovered];
      },
      EXISTING_LIST,
    );
    if (
      !persisted.some(
        (row) =>
          row.id === request.worktreeId && row.createdAt === request.createdAt,
      )
    ) {
      throw new SplitRecordRefusedError(
        'not-found',
        `Split destination reservation ${request.workspaceId}/${request.worktreeId} disappeared before promotion.`,
      );
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
    await updateWorkspaceWorktrees(
      request.workspaceId,
      (rows) => {
        const current = rows.find((row) => row.id === request.worktreeId);
        if (!current)
          throw new SplitRecordRefusedError(
            'not-found',
            `Split destination reservation ${request.workspaceId}/${request.worktreeId} disappeared before promotion.`,
          );
        assertIdentity(request, current);
        const ready: WorktreeData = {
          ...current,
          branchName: request.branchName,
          setupPhase: 'git-ready',
        };
        delete ready.splitRecoveryRequired;
        return rows.map((row) => (row === current ? ready : row));
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
    const persisted = await updateWorkspaceWorktrees(
      request.workspaceId,
      (rows) => {
        const current = rows.find((row) => row.id === identity.worktreeId);
        if (current) assertIdentity(identity, current);
        else assertNotRemoved(identity);
        const recorded: WorktreeData = current
          ? { ...current, branchName: request.worktree.branchName }
          : { ...request.worktree };
        if (request.worktree.status !== undefined)
          recorded.status = request.worktree.status;
        delete recorded.hidden;
        delete recorded.setupPhase;
        delete recorded.splitRecoveryRequired;
        return current
          ? rows.map((row) => (row === current ? recorded : row))
          : [...rows, recorded];
      },
      EXISTING_LIST,
    );
    if (
      !persisted.some(
        (row) =>
          row.id === identity.worktreeId &&
          row.createdAt === identity.createdAt,
      )
    ) {
      throw new SplitRecordRefusedError(
        'not-found',
        `Split destination reservation ${request.workspaceId}/${identity.worktreeId} disappeared before promotion.`,
      );
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
            await removeWorkspaceIndexEntry(request.workspaceId);
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
