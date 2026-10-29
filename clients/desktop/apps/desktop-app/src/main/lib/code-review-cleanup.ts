import { rm } from 'node:fs/promises';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { getChatStateService } from '../services/chat-state-service';
import { getChatSearchService } from '../chat-search/service';
import { cleanupWorktreeChatPluginDirs } from '../plugins/plugin-cleanup';
import {
  listCodeReviewTargets,
  removeCodeReviewTarget,
} from './code-review-registry';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import { getWorktreeAttachmentsDir, getWorktreeDataRootDir } from './paths';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';

/** Retained compatibility cleanup only. Closing a panel never calls this. */
export async function removeCodeReviewChatsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const [scopeKey, owner] of Object.entries(
    await listCodeReviewTargets(),
  )) {
    if (owner.projectId !== projectId || owner.worktreeId !== worktreeId)
      continue;
    const scope = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: scopeKey,
    };
    try {
      // Stop on a failed fence: neither storage nor ownership may disappear while a writer is alive.
      await cleanupLiveWorktreeState(scope.projectId, scope.worktreeId);
      await getChatStateService().deleteScope(scope);
      try {
        await getChatSearchService().deleteWorktreeDocs(
          scope.projectId,
          scope.worktreeId,
        );
      } catch (error) {
        // Search rows are rebuildable derived data and must not abort the
        // remaining durable cleanup or ownership removal.
        // eslint-disable-next-line no-console
        console.error(
          `[code-review-cleanup] Failed to remove derived chat search rows for legacy review chat ${scopeKey}`,
          error,
        );
      }
      await purgeLiveWorktreeObservabilityData(
        scope.projectId,
        scope.worktreeId,
      );
      cleanupWorktreeChatPluginDirs(scope.projectId, scope.worktreeId);
      await rm(getWorktreeAttachmentsDir(scope.projectId, scope.worktreeId), {
        recursive: true,
        force: true,
      });
      await removePersistedWorktreeDataDirectory(
        scope.projectId,
        scope.worktreeId,
        {
          worktreeDataRootDir: getWorktreeDataRootDir(scope.projectId),
          removeTree: removeTreeWithoutAsar,
        },
      );
      await removeCodeReviewTarget(scopeKey);
    } catch (error) {
      warnings.push(
        `Failed to remove legacy review chat ${scopeKey}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return warnings;
}
