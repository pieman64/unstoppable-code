import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getWorktreeDataRootDir } from '../lib/paths';
import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';
import { getChatStateService } from '../services/chat-state-service';

/** Remove app-managed panel/view state when its recipient replica is purged. */
export async function cleanupSharedContainerRecipientViewState(
  containerId: string,
): Promise<void> {
  await getChatStateService().deleteScope({
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: containerId,
  });
  await removePersistedWorktreeDataDirectory(
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    containerId,
    {
      worktreeDataRootDir: getWorktreeDataRootDir(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
      ),
      removeTree: removeTreeWithoutAsar,
    },
  );
}
