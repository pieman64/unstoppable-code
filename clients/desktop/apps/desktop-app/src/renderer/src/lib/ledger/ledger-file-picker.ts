import type { LedgerFilePicker } from '@canopy/app-core';
import type { LedgerViewFileCandidate } from '@canopy/protocol/ledger-view';
import { searchFiles } from '@/lib/fuzzySearch';
import {
  getWorktreeCacheKey,
  useFileListStore,
  withRetainedFileIndex,
} from '@/stores/fileListStore';

/** A scope's file index is reused this long before it is read again. */
const INDEX_REUSE_MS = 30_000;

/**
 * Files for a Ledger entry's references, from the scope's file index (the one
 * file search and mentions use). A pick is a root ID and a path relative to
 * that root; nothing is read from the file. A scope without an index, such as
 * one whose files could not be listed, finds nothing.
 */
export const DESKTOP_LEDGER_FILE_PICKER: LedgerFilePicker = {
  searchFiles: async (
    scope,
    query,
    limit,
  ): Promise<readonly LedgerViewFileCandidate[]> => {
    const key = getWorktreeCacheKey(scope.projectId, scope.worktreeId);
    return withRetainedFileIndex(
      key,
      async (): Promise<readonly LedgerViewFileCandidate[]> => {
        const cached = useFileListStore.getState().indexCache[key];
        if (
          cached === undefined ||
          Date.now() - cached.fetchedAt > INDEX_REUSE_MS
        ) {
          await useFileListStore
            .getState()
            .fetchFileIndex(scope.projectId, scope.worktreeId);
        }
        const entry = useFileListStore.getState().indexCache[key];
        if (entry === undefined) return [];
        return searchFiles(query, entry.data.repos, limit, 'path-coverage').map(
          (result): LedgerViewFileCandidate => ({
            rootId: result.repoId,
            rootName: result.repoName,
            path: result.relativePath,
          }),
        );
      },
    );
  },
};
