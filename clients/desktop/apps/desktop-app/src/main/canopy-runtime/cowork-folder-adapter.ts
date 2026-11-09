import type {
  CoworkFolderStatus,
  CoworkUnstartedSend,
} from '@canopy/protocol/canopy-core';
import { checkCoworkExternalFolder } from '../lib/cowork-folder-guard';
import { requireCoworkFolderProject } from '../lib/cowork-folder-project';
import { validateId } from '../lib/validation';

/** Host registry binding; the daemon does not yet own the Cowork path registry. */
export function createCoworkFolderAdapter(): {
  'core.workspace.cowork.folder.check': (params: {
    workspaceId: string;
  }) => Promise<CoworkFolderStatus>;
  'core.workspace.cowork.send.rollback': (
    params: CoworkUnstartedSend,
  ) => Promise<void>;
} {
  return {
    'core.workspace.cowork.folder.check': async ({ workspaceId }) => {
      const canonical = await requireCoworkFolderProject(workspaceId);
      return checkCoworkExternalFolder(canonical);
    },
    'core.workspace.cowork.send.rollback': async (params) => {
      const workspaceId = await requireCoworkFolderProject(params.workspaceId);
      validateId(params.worktreeId, 'worktreeId');
      validateId(params.chatId, 'chatId');
      // The same canonical writers used by main-owned sends. No whole-entry
      // deletion: sibling chats and concurrent input make cleanup a no-op.
      const [{ getChatStateService }, { removeUnstartedWorkEntry }] =
        await Promise.all([
          import('../services/chat-state-service'),
          import('../lib/cowork-work-entries'),
        ]);
      const service = getChatStateService();
      const scope = { projectId: workspaceId, worktreeId: params.worktreeId };
      // Keep chat admission and repository mutations fenced through the
      // empty-entry check and registry commit, closing the sibling-write race.
      await service.runWithScopeDeletion(scope, async () => {
        await service.rollbackUnstartedCoworkTab(
          scope,
          params.chatId,
          [params.userMessageId],
          true,
        );
        if (params.entryCreatedAt !== undefined)
          await removeUnstartedWorkEntry(
            workspaceId,
            params.worktreeId,
            params.entryCreatedAt,
          );
      });
    },
  };
}
