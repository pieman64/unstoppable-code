/**
 * Workspace items IPC — Notes/Prompts/Attachments for the shared activity
 * cards. Notes, prompts and attachment imports and lists are compatibility
 * projections over `core.workspace.item.*` on the desktop dispatcher; the
 * desktop host adapters keep the Cowork and Code stores (and their writers)
 * unchanged:
 *
 * - Cowork workspaces keep the brand-managed subdirs under the cowork
 *   working folder (`../lib/standalone-workspace-files`).
 * - Code workspaces store notes/prompts machine-locally under
 *   `{dataDir}/workspaces/{workspaceId}/notes|prompts/` with branch-origin
 *   tracking (`../lib/workspace-items`), and keep attachments in the
 *   per-worktree attachment dirs.
 *
 * The renderer is storage-agnostic: one `window.api.workspaceItems` surface.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type WorkspaceAttachmentDeleteRequest,
  type WorkspaceAttachmentItem,
  type WorkspaceAttachmentsImportRequest,
  type WorkspaceAttachmentsImportResponse,
  type WorkspaceAttachmentsListRequest,
  type WorkspaceNoteDeleteRequest,
  type WorkspaceNoteItem,
  type WorkspaceNoteReadRequest,
  type WorkspaceNoteReadResponse,
  type WorkspaceNoteSaveRequest,
  type WorkspaceNotesListRequest,
  type WorkspacePromptDeleteRequest,
  type WorkspacePromptItem,
  type WorkspacePromptReadByPathRequest,
  type WorkspacePromptReadByPathResponse,
  type WorkspacePromptReadRequest,
  type WorkspacePromptReadResponse,
  type WorkspacePromptSaveRequest,
  type WorkspacePromptsListRequest,
} from '@canopy/desktop-shared/types';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { isWorkEntryWorkspace } from '../lib/workspace-registry';
import { deleteAttachment as deleteCoworkAttachment } from '../lib/standalone-workspace-files';
import { isPathInside } from '../lib/path-safety';
import { readWorkspacePromptBodyByPath } from '../lib/workspace-prompt-mentions';
import { chooseFilesForEvent } from '../lib/dialog-window';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import {
  importAttachmentsForIpc,
  listAttachmentsForIpc,
  workspaceItemsChannelScope,
  type WorkspaceItemsDispatcher,
} from '../canopy-runtime/workspace-item-attachments-dispatch';
import {
  deleteTextItemForIpc,
  listTextItemsForIpc,
  readTextItemForIpc,
  saveTextItemForIpc,
} from '../canopy-runtime/workspace-item-notes-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/** The dispatcher and caller resolver the workspace item channels project onto. */
export interface WorkspaceItemsIpcRuntime {
  dispatcher: WorkspaceItemsDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}

export function registerWorkspaceItemHandlers(
  runtime: WorkspaceItemsIpcRuntime,
): void {
  // Notes and prompts: core.workspace.item.list, get, upsert and delete. Each
  // handler reads its fields first, so a missing payload keeps its legacy
  // TypeError.
  registerIpcHandler<[WorkspaceNotesListRequest], WorkspaceNoteItem[]>(
    IPC_CHANNELS.workspaceNotesList,
    async (event, req) => {
      const projectId = req.projectId;
      const worktreeId = req.worktreeId;
      return listTextItemsForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'note',
        projectId,
        worktreeId,
      );
    },
  );

  registerIpcHandler<[WorkspaceNoteReadRequest], WorkspaceNoteReadResponse>(
    IPC_CHANNELS.workspaceNotesRead,
    async (event, req) => {
      const projectId = req.projectId;
      const noteId = req.noteId;
      const worktreeId = req.worktreeId;
      return readTextItemForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'note',
        projectId,
        noteId,
        worktreeId,
      );
    },
  );

  registerIpcHandler<[WorkspaceNoteSaveRequest], WorkspaceNoteItem>(
    IPC_CHANNELS.workspaceNotesSave,
    async (event, req) => {
      const projectId = req.projectId;
      const noteId = req.noteId;
      const title = req.title;
      const content = req.content;
      const originWorktreeId = req.originWorktreeId;
      return saveTextItemForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'note',
        {
          projectId,
          ...(noteId !== undefined ? { itemId: noteId } : {}),
          title,
          content,
          ...(originWorktreeId !== undefined ? { originWorktreeId } : {}),
        },
      );
    },
  );

  registerIpcHandler<[WorkspaceNoteDeleteRequest], void>(
    IPC_CHANNELS.workspaceNotesDelete,
    async (event, req) => {
      const projectId = req.projectId;
      const noteId = req.noteId;
      await deleteTextItemForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'note',
        projectId,
        noteId,
      );
    },
  );

  registerIpcHandler<[WorkspacePromptsListRequest], WorkspacePromptItem[]>(
    IPC_CHANNELS.workspacePromptsList,
    async (event, req) => {
      const projectId = req.projectId;
      const worktreeId = req.worktreeId;
      return listTextItemsForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'prompt',
        projectId,
        worktreeId,
      );
    },
  );

  registerIpcHandler<[WorkspacePromptReadRequest], WorkspacePromptReadResponse>(
    IPC_CHANNELS.workspacePromptsRead,
    async (event, req) => {
      const projectId = req.projectId;
      const promptId = req.promptId;
      const worktreeId = req.worktreeId;
      return readTextItemForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'prompt',
        projectId,
        promptId,
        worktreeId,
      );
    },
  );

  registerIpcHandler<
    [WorkspacePromptReadByPathRequest],
    WorkspacePromptReadByPathResponse
  >(IPC_CHANNELS.workspacePromptsReadByPath, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    // shortcut: prompt-mention expansion reads by host path until provider
    // prompt consumption moves to core (Phase 5 inventory debt). Path
    // validation and the read live in the shared main lib so the portal send
    // path's expansion enforces the exact same containment.
    return {
      content: await readWorkspacePromptBodyByPath(
        req.projectId,
        req.absolutePath,
      ),
    };
  });

  registerIpcHandler<[WorkspacePromptSaveRequest], WorkspacePromptItem>(
    IPC_CHANNELS.workspacePromptsSave,
    async (event, req) => {
      const projectId = req.projectId;
      const promptId = req.promptId;
      const title = req.title;
      const content = req.content;
      const originWorktreeId = req.originWorktreeId;
      return saveTextItemForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'prompt',
        {
          projectId,
          ...(promptId !== undefined ? { itemId: promptId } : {}),
          title,
          content,
          ...(originWorktreeId !== undefined ? { originWorktreeId } : {}),
        },
      );
    },
  );

  registerIpcHandler<[WorkspacePromptDeleteRequest], void>(
    IPC_CHANNELS.workspacePromptsDelete,
    async (event, req) => {
      const projectId = req.projectId;
      const promptId = req.promptId;
      await deleteTextItemForIpc(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        'prompt',
        projectId,
        promptId,
      );
    },
  );

  registerIpcHandler<
    [WorkspaceAttachmentsListRequest],
    WorkspaceAttachmentItem[]
  >(IPC_CHANNELS.workspaceAttachmentsList, async (event, req) => {
    // core.workspace.item.list; read the fields first so a missing payload
    // keeps its legacy TypeError.
    const projectId = req.projectId;
    const worktreeId = req.worktreeId;
    return listAttachmentsForIpc(
      runtime.dispatcher,
      runtime.resolveCaller(event),
      projectId,
      worktreeId,
    );
  });

  registerIpcHandler<
    [WorkspaceAttachmentsImportRequest],
    WorkspaceAttachmentsImportResponse
  >(IPC_CHANNELS.workspaceAttachmentsImport, async (event, req) => {
    validateId(req.projectId, 'projectId');
    validateId(req.worktreeId, 'worktreeId');
    assertWritableScope(req.projectId);
    const caller = runtime.resolveCaller(event);

    const hasClipboardItems =
      req.clipboardItems !== undefined && req.clipboardItems.length > 0;
    // The native chooser stays in this host handler; only its picks travel.
    const selectedFilePaths =
      req.filePaths.length > 0 || hasClipboardItems
        ? req.filePaths
        : await chooseFilesForEvent(event, 'Import attachments');
    if (selectedFilePaths.length === 0 && !hasClipboardItems) {
      return { attachments: [] };
    }

    // core.workspace.item.import; Cowork and App Advisor keep workspace-level
    // attachments.
    return {
      attachments: await importAttachmentsForIpc(runtime.dispatcher, caller, {
        scope: workspaceItemsChannelScope(req.projectId, req.worktreeId),
        filePaths: selectedFilePaths,
        clipboardItems: req.clipboardItems ?? [],
      }),
    };
  });

  registerIpcHandler<[WorkspaceAttachmentDeleteRequest], void>(
    IPC_CHANNELS.workspaceAttachmentsDelete,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      validateId(req.worktreeId, 'worktreeId');
      assertWritableScope(req.projectId);
      if (isWorkEntryWorkspace(req.projectId)) {
        await deleteCoworkAttachment(req.projectId, req.filename);
        return;
      }
      // shortcut: delete stays on the host writer until CAN-4152 lands
      // core.workspace.item.delete (CAN-4105 inventory debt).
      const dir = resolveAgentAttachmentsDir(req.projectId, req.worktreeId);
      const target = join(dir, req.filename);
      if (!isPathInside(dir, target)) {
        throw new Error('Invalid attachment filename');
      }
      await rm(target, { force: true });
    },
  );
}
