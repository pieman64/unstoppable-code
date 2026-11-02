import {
  createWorktreeListRepository as createCoreWorktreeListRepository,
  parseWorktreeList as parseCoreWorktreeList,
  type W5WorktreeListReadRow,
  type WorktreeListRead as CoreWorktreeListRead,
  type WorktreeListRepository as CoreWorktreeListRepository,
  type WorktreeListRepositoryDeps as CoreWorktreeListRepositoryDeps,
} from '@canopy/core-runtime/node/w5/worktree-list-repository';
import type { WorktreeData } from '@canopy/desktop-shared/types';

export { WorktreeRegistryUnreadableError } from '@canopy/core-runtime/node/w5/worktree-list-repository';

export type WorktreeListRead = CoreWorktreeListRead<WorktreeData>;
export type WorktreeListRepository = CoreWorktreeListRepository<WorktreeData>;
/** Desktop main reads rows as {@link WorktreeData}. */
export type WorktreeListRepositoryDeps = Omit<
  CoreWorktreeListRepositoryDeps<WorktreeData>,
  'readRow'
>;

// The row keeps every stored field, as the list reader always has.
function readRow(row: W5WorktreeListReadRow): WorktreeData {
  return row;
}

export function parseWorktreeList(
  raw: string,
  workspaceId: string,
): WorktreeListRead {
  return parseCoreWorktreeList(raw, workspaceId, readRow);
}

/** The desktop `<data>/workspaces/{id}/worktrees.json` repository (CAN-3803). */
export function createWorktreeListRepository(
  deps: WorktreeListRepositoryDeps,
): WorktreeListRepository {
  return createCoreWorktreeListRepository({ ...deps, readRow });
}
