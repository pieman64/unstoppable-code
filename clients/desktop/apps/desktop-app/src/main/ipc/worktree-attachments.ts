import {
  IPC_CHANNELS,
  type WorktreeImportAttachmentsRequest,
  type WorktreeImportAttachmentsResponse,
} from '@canopy/desktop-shared/types';
import { importAttachmentsForIpc } from '../canopy-runtime/workspace-item-attachments-dispatch';
import { chooseFilesForEvent } from '../lib/dialog-window';
import { assertWritableScope } from '../lib/read-only-scope';
import { validateId } from '../lib/validation';
import type { WorkspaceItemsIpcRuntime } from './workspace-items';
import { registerIpcHandler } from './register';

export function registerWorktreeAttachmentHandlers(
  runtime: WorkspaceItemsIpcRuntime,
): void {
  // core.workspace.item.import into the worktree's own attachments folder.
  registerIpcHandler<
    [WorktreeImportAttachmentsRequest],
    WorktreeImportAttachmentsResponse
  >(IPC_CHANNELS.worktreeImportAttachments, async (event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    // CAN-4105: the read-only viewer is refused, as on workspace-items.
    assertWritableScope(req.projectId);
    const caller = runtime.resolveCaller(event);

    const hasClipboardItems =
      req.clipboardItems && req.clipboardItems.length > 0;
    // The native chooser stays in this host handler; only its picks travel.
    const selectedFilePaths =
      req.filePaths.length > 0 || hasClipboardItems
        ? req.filePaths
        : await chooseFilesForEvent(event, 'Import attachments');

    if (selectedFilePaths.length === 0 && !hasClipboardItems) {
      return { attachments: [] };
    }

    const imported = await importAttachmentsForIpc(runtime.dispatcher, caller, {
      scope: { workspaceId: req.projectId, worktreeId: req.worktreeId },
      filePaths: selectedFilePaths,
      clipboardItems: req.clipboardItems ?? [],
    });
    return {
      attachments: imported.map(({ filename, absolutePath, sizeBytes }) => ({
        filename,
        absolutePath,
        sizeBytes,
      })),
    };
  });
}
