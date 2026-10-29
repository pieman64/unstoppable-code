import {
  IPC_CHANNELS,
  type AttachmentMeta,
  type ClipboardAttachmentData,
  type WorktreeImportAttachmentsRequest,
  type WorktreeImportAttachmentsResponse,
} from '@canopy/desktop-shared/types';
import { getWorktreeAttachmentsDir } from '../lib/paths';
import {
  copyAttachmentFileToDir,
  writeClipboardAttachmentToDir,
} from '../lib/standalone-workspace-files';
import { chooseFilesForEvent } from '../lib/dialog-window';
import { validateId } from '../lib/validation';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { getWorkspaceWorktreeAttachmentsDir } from '../lib/paths';
import { registerIpcHandler } from './register';

function resolveAttachmentsDir(projectId: string, worktreeId: string): string {
  if (isMultiRepoWorkspace(projectId)) {
    return getWorkspaceWorktreeAttachmentsDir(projectId, worktreeId);
  }
  return getWorktreeAttachmentsDir(projectId, worktreeId);
}

async function importSingleAttachment(
  dir: string,
  sourcePath: string,
): Promise<AttachmentMeta> {
  const copied = await copyAttachmentFileToDir(dir, sourcePath);
  return {
    filename: copied.filename,
    absolutePath: copied.absolutePath,
    sizeBytes: copied.sizeBytes,
  };
}

async function importClipboardAttachment(
  dir: string,
  item: ClipboardAttachmentData,
): Promise<AttachmentMeta> {
  const copied = await writeClipboardAttachmentToDir(dir, item);
  return {
    filename: copied.filename,
    absolutePath: copied.absolutePath,
    sizeBytes: copied.sizeBytes,
  };
}

export function registerWorktreeAttachmentHandlers(): void {
  registerIpcHandler<
    [WorktreeImportAttachmentsRequest],
    WorktreeImportAttachmentsResponse
  >(IPC_CHANNELS.worktreeImportAttachments, async (event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');

    const hasClipboardItems =
      req.clipboardItems && req.clipboardItems.length > 0;
    const selectedFilePaths =
      req.filePaths.length > 0 || hasClipboardItems
        ? req.filePaths
        : await chooseFilesForEvent(event, 'Import attachments');

    if (selectedFilePaths.length === 0 && !hasClipboardItems) {
      return { attachments: [] };
    }

    const dir = resolveAttachmentsDir(req.projectId, req.worktreeId);
    const fileAttachments = await Promise.all(
      selectedFilePaths.map((filePath) =>
        importSingleAttachment(dir, filePath),
      ),
    );
    const clipboardAttachments = await Promise.all(
      (req.clipboardItems ?? []).map((item) =>
        importClipboardAttachment(dir, item),
      ),
    );
    return { attachments: [...fileAttachments, ...clipboardAttachments] };
  });
}
