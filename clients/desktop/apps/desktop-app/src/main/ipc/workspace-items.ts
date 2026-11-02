/**
 * Workspace items IPC — Notes/Prompts/Attachments for the shared activity
 * cards, with a storage adapter per workspace type:
 *
 * - Cowork workspaces keep the brand-managed subdirs under the cowork
 *   working folder (delegates to `../lib/standalone-workspace-files`), so
 *   existing cowork data needs no migration and the agent-facing folder
 *   layout stays valid.
 * - Code workspaces store notes/prompts machine-locally under
 *   `{dataDir}/workspaces/{workspaceId}/notes|prompts/` with branch-origin
 *   tracking (delegates to `../lib/workspace-items`), and read attachments
 *   from the existing per-worktree attachment dirs (storage unchanged).
 *
 * The renderer is storage-agnostic: one `window.api.workspaceItems` surface.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
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
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { getAppAdvisorHomeDir, getCoworkWorkspaceRootDir } from '../lib/paths';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isWorkEntryWorkspace } from '../lib/workspace-registry';
import {
  deleteAttachment as deleteCoworkAttachment,
  saveNote as saveCoworkNote,
  savePrompt as saveCoworkPrompt,
} from '../lib/standalone-workspace-files';
import {
  deleteWorkspaceNote,
  deleteWorkspacePrompt,
  saveWorkspaceNote,
  saveWorkspacePrompt,
} from '../lib/workspace-items';
import { isPathInside } from '../lib/path-safety';
import { readWorkspacePromptBodyByPath } from '../lib/workspace-prompt-mentions';
import { chooseFilesForEvent } from '../lib/dialog-window';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import {
  removeSharedContainerScopeItemId,
  replaceSharedContainerScopeItemId,
} from '../shared-containers/file-scope-store';
import { getSharedContainerPublishScheduler } from '../shared-containers/publish/scheduler';
import {
  listNotesForProject,
  readNoteForProject,
  listPromptsForProject,
  readPromptForProject,
} from '../services/workspace-items-service';
import {
  importAttachmentsForIpc,
  listAttachmentsForIpc,
  workspaceItemsChannelScope,
  type WorkspaceItemsDispatcher,
} from '../canopy-runtime/workspace-item-attachments-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/** The dispatcher and caller resolver the attachment channels project onto. */
export interface WorkspaceItemsIpcRuntime {
  dispatcher: WorkspaceItemsDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}

function scheduleWorkspaceItemPublication(projectId: string): void {
  void getSharedContainerPublishScheduler()
    .scheduleWorkspace(projectId)
    .catch((error) =>
      logMainProcessWarn(
        '[shared-containers] failed to schedule workspace-item publication',
        error,
      ),
    );
}

function workEntryHomeDir(projectId: string): string {
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return getAppAdvisorHomeDir();
  }
  return getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId));
}

/**
 * A cowork note/prompt meta mapped onto the shared renderer item shape.
 * Cowork items never carry branch origins (there are no branches).
 */
function coworkItemToWorkspaceItem(
  meta: { id: string; title: string; createdAt: string; updatedAt: string },
  dir: string,
): WorkspaceNoteItem {
  return {
    id: meta.id,
    title: meta.title,
    absolutePath: join(dir, `${meta.id}.md`),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export function registerWorkspaceItemHandlers(
  runtime: WorkspaceItemsIpcRuntime,
): void {
  registerIpcHandler<[WorkspaceNotesListRequest], WorkspaceNoteItem[]>(
    IPC_CHANNELS.workspaceNotesList,
    async (_event, req) => {
      return listNotesForProject(req.projectId, req.worktreeId);
    },
  );

  registerIpcHandler<[WorkspaceNoteReadRequest], WorkspaceNoteReadResponse>(
    IPC_CHANNELS.workspaceNotesRead,
    async (_event, req) => {
      return readNoteForProject(req.projectId, req.noteId, req.worktreeId);
    },
  );

  registerIpcHandler<[WorkspaceNoteSaveRequest], WorkspaceNoteItem>(
    IPC_CHANNELS.workspaceNotesSave,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      assertWritableScope(req.projectId);
      if (req.noteId !== undefined) validateId(req.noteId, 'noteId');
      if (req.originWorktreeId !== undefined) {
        validateId(req.originWorktreeId, 'originWorktreeId');
      }
      if (isWorkEntryWorkspace(req.projectId)) {
        const dir = getCoworkManagedSubdir(
          workEntryHomeDir(req.projectId),
          'notes',
        );
        const meta = await saveCoworkNote(
          req.projectId,
          req.title,
          req.content,
          req.noteId,
        );
        return coworkItemToWorkspaceItem(meta, dir);
      }
      const note = await saveWorkspaceNote({
        workspaceId: req.projectId,
        ...(req.noteId !== undefined ? { noteId: req.noteId } : {}),
        title: req.title,
        content: req.content,
        ...(req.originWorktreeId !== undefined
          ? { originWorktreeId: req.originWorktreeId }
          : {}),
      });
      if (req.noteId !== undefined) {
        await replaceSharedContainerScopeItemId(
          req.projectId,
          'note',
          req.noteId,
          note.id,
        );
      }
      scheduleWorkspaceItemPublication(req.projectId);
      return note;
    },
  );

  registerIpcHandler<[WorkspaceNoteDeleteRequest], void>(
    IPC_CHANNELS.workspaceNotesDelete,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      assertWritableScope(req.projectId);
      validateId(req.noteId, 'noteId');
      if (isWorkEntryWorkspace(req.projectId)) {
        const dir = getCoworkManagedSubdir(
          workEntryHomeDir(req.projectId),
          'notes',
        );
        const target = join(dir, `${req.noteId}.md`);
        if (!isPathInside(dir, target)) {
          throw new Error('Invalid note id');
        }
        await rm(target, { force: true });
        return;
      }
      await deleteWorkspaceNote(req.projectId, req.noteId);
      await removeSharedContainerScopeItemId(req.projectId, 'note', req.noteId);
      scheduleWorkspaceItemPublication(req.projectId);
    },
  );

  registerIpcHandler<[WorkspacePromptsListRequest], WorkspacePromptItem[]>(
    IPC_CHANNELS.workspacePromptsList,
    async (_event, req) => {
      return listPromptsForProject(req.projectId, req.worktreeId);
    },
  );

  registerIpcHandler<[WorkspacePromptReadRequest], WorkspacePromptReadResponse>(
    IPC_CHANNELS.workspacePromptsRead,
    async (_event, req) => {
      return readPromptForProject(req.projectId, req.promptId, req.worktreeId);
    },
  );

  registerIpcHandler<
    [WorkspacePromptReadByPathRequest],
    WorkspacePromptReadByPathResponse
  >(IPC_CHANNELS.workspacePromptsReadByPath, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    // Path validation + read live in the shared main lib so the portal send
    // path's prompt-mention expansion enforces the exact same containment.
    return {
      content: await readWorkspacePromptBodyByPath(
        req.projectId,
        req.absolutePath,
      ),
    };
  });

  registerIpcHandler<[WorkspacePromptSaveRequest], WorkspacePromptItem>(
    IPC_CHANNELS.workspacePromptsSave,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      assertWritableScope(req.projectId);
      if (req.promptId !== undefined) validateId(req.promptId, 'promptId');
      if (req.originWorktreeId !== undefined) {
        validateId(req.originWorktreeId, 'originWorktreeId');
      }
      if (isWorkEntryWorkspace(req.projectId)) {
        const dir = getCoworkManagedSubdir(
          workEntryHomeDir(req.projectId),
          'prompts',
        );
        const meta = await saveCoworkPrompt(
          req.projectId,
          req.title,
          req.content,
          req.promptId,
        );
        return coworkItemToWorkspaceItem(meta, dir);
      }
      const prompt = await saveWorkspacePrompt({
        workspaceId: req.projectId,
        ...(req.promptId !== undefined ? { promptId: req.promptId } : {}),
        title: req.title,
        content: req.content,
        ...(req.originWorktreeId !== undefined
          ? { originWorktreeId: req.originWorktreeId }
          : {}),
      });
      if (req.promptId !== undefined) {
        await replaceSharedContainerScopeItemId(
          req.projectId,
          'prompt',
          req.promptId,
          prompt.id,
        );
      }
      scheduleWorkspaceItemPublication(req.projectId);
      return prompt;
    },
  );

  registerIpcHandler<[WorkspacePromptDeleteRequest], void>(
    IPC_CHANNELS.workspacePromptsDelete,
    async (_event, req) => {
      validateId(req.projectId, 'projectId');
      assertWritableScope(req.projectId);
      validateId(req.promptId, 'promptId');
      if (isWorkEntryWorkspace(req.projectId)) {
        const dir = getCoworkManagedSubdir(
          workEntryHomeDir(req.projectId),
          'prompts',
        );
        const target = join(dir, `${req.promptId}.md`);
        if (!isPathInside(dir, target)) {
          throw new Error('Invalid prompt id');
        }
        await rm(target, { force: true });
        return;
      }
      await deleteWorkspacePrompt(req.projectId, req.promptId);
      await removeSharedContainerScopeItemId(
        req.projectId,
        'prompt',
        req.promptId,
      );
      scheduleWorkspaceItemPublication(req.projectId);
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
