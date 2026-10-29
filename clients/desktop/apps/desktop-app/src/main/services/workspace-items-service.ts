import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorkspaceNoteItem,
  type WorkspaceNoteReadResponse,
  type WorkspacePromptItem,
  type WorkspacePromptReadResponse,
  type WorkspaceAttachmentItem,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { getAppAdvisorHomeDir, getCoworkWorkspaceRootDir } from '../lib/paths';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isWorkEntryWorkspace } from '../lib/workspace-registry';
import { validateId } from '../lib/validation';
import {
  listAttachmentsInDir,
  resolveAgentAttachmentsDir,
} from '../lib/agent-attachments';
import {
  listNotes as listCoworkNotes,
  listPrompts as listCoworkPrompts,
  readNote as readCoworkNote,
  readPrompt as readCoworkPrompt,
  listAttachments as listCoworkAttachments,
} from '../lib/standalone-workspace-files';
import {
  listWorkspaceNotes,
  listWorkspacePrompts,
  readWorkspaceNote,
  readWorkspacePrompt,
} from '../lib/workspace-items';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';

async function viewerRevision(worktreeId: string | undefined): Promise<{
  containerId: string;
  revisionId: string;
  root: string;
}> {
  if (!worktreeId) {
    throw new Error('Shared-container viewer reads require a worktree id');
  }
  validateId(worktreeId, 'worktreeId');
  const roots = await resolveSharedContainerViewerReadRoots(worktreeId);
  const first = roots[0];
  if (!first) throw new Error('Shared-container revision has no readable root');
  return {
    containerId: worktreeId,
    revisionId: first.revisionId,
    root: first.revisionRoot,
  };
}

async function listAllViewerItems(
  kind: 'notes' | 'prompts',
  worktreeId: string | undefined,
): Promise<WorkspaceNoteItem[]> {
  const request = await viewerRevision(worktreeId);
  const reader = getSharedContainerReader();
  const items: WorkspaceNoteItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader[kind === 'notes' ? 'listNotes' : 'listPrompts']({
      containerId: request.containerId,
      revisionId: request.revisionId,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    items.push(
      ...page.items.map((item) => ({
        id: item.itemId,
        title: item.title,
        absolutePath: reader.store.resolvePathBelowForRead(
          request.root,
          'content',
          kind,
          `${item.itemId}.md`,
        ),
        createdAt: item.createdAt ?? item.updatedAt ?? '',
        updatedAt: item.updatedAt ?? item.createdAt ?? '',
      })),
    );
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
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

export async function listNotesForProject(
  projectId: string,
  worktreeId?: string,
): Promise<WorkspaceNoteItem[]> {
  validateId(projectId, 'projectId');
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return listAllViewerItems('notes', worktreeId);
  }
  if (isWorkEntryWorkspace(projectId)) {
    const dir = getCoworkManagedSubdir(workEntryHomeDir(projectId), 'notes');
    const notes = await listCoworkNotes(projectId);
    return notes.map(
      (meta): WorkspaceNoteItem => coworkItemToWorkspaceItem(meta, dir),
    );
  }
  return listWorkspaceNotes(projectId);
}

export async function listPromptsForProject(
  projectId: string,
  worktreeId?: string,
): Promise<WorkspacePromptItem[]> {
  validateId(projectId, 'projectId');
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return listAllViewerItems('prompts', worktreeId);
  }
  if (isWorkEntryWorkspace(projectId)) {
    const dir = getCoworkManagedSubdir(workEntryHomeDir(projectId), 'prompts');
    const prompts = await listCoworkPrompts(projectId);
    return prompts.map(
      (meta): WorkspacePromptItem => coworkItemToWorkspaceItem(meta, dir),
    );
  }
  return listWorkspacePrompts(projectId);
}

export async function readNoteForProject(
  projectId: string,
  noteId: string,
  worktreeId?: string,
): Promise<WorkspaceNoteReadResponse> {
  validateId(projectId, 'projectId');
  validateId(noteId, 'noteId');
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const revision = await viewerRevision(worktreeId);
    const items = await listAllViewerItems('notes', worktreeId);
    const meta = items.find((item) => item.id === noteId);
    if (!meta) throw new Error('Shared-container note is not declared');
    return {
      meta,
      content: await getSharedContainerReader().readNote({
        containerId: revision.containerId,
        revisionId: revision.revisionId,
        itemId: noteId,
      }),
    };
  }
  if (isWorkEntryWorkspace(projectId)) {
    const dir = getCoworkManagedSubdir(workEntryHomeDir(projectId), 'notes');
    const { meta, content } = await readCoworkNote(projectId, noteId);
    return { meta: coworkItemToWorkspaceItem(meta, dir), content };
  }
  return readWorkspaceNote(projectId, noteId);
}

export async function readPromptForProject(
  projectId: string,
  promptId: string,
  worktreeId?: string,
): Promise<WorkspacePromptReadResponse> {
  validateId(projectId, 'projectId');
  validateId(promptId, 'promptId');
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const revision = await viewerRevision(worktreeId);
    const items = await listAllViewerItems('prompts', worktreeId);
    const meta = items.find((item) => item.id === promptId);
    if (!meta) throw new Error('Shared-container prompt is not declared');
    return {
      meta,
      content: await getSharedContainerReader().readPrompt({
        containerId: revision.containerId,
        revisionId: revision.revisionId,
        itemId: promptId,
      }),
    };
  }
  if (isWorkEntryWorkspace(projectId)) {
    const dir = getCoworkManagedSubdir(workEntryHomeDir(projectId), 'prompts');
    const { meta, content } = await readCoworkPrompt(projectId, promptId);
    return { meta: coworkItemToWorkspaceItem(meta, dir), content };
  }
  return readWorkspacePrompt(projectId, promptId);
}

export async function listAttachmentsForProject(
  projectId: string,
  worktreeId: string,
): Promise<WorkspaceAttachmentItem[]> {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const revision = await viewerRevision(worktreeId);
    const reader = getSharedContainerReader();
    const items: WorkspaceAttachmentItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.listAttachments({
        containerId: revision.containerId,
        revisionId: revision.revisionId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
      });
      for (const summary of page.items) {
        const attachment = await reader.readAttachment({
          containerId: revision.containerId,
          revisionId: revision.revisionId,
          attachmentId: summary.attachmentId,
        });
        items.push({
          filename: attachment.displayName,
          absolutePath: reader.store.resolvePathBelowForRead(
            revision.root,
            'content',
            'attachments',
            attachment.displayName,
          ),
          sizeBytes: Number(attachment.sizeBytes),
          createdAt: '',
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }
  if (isWorkEntryWorkspace(projectId)) {
    const attachments = await listCoworkAttachments(projectId);
    return attachments
      .map(
        (meta): WorkspaceAttachmentItem => ({
          filename: meta.filename,
          absolutePath: meta.absolutePath,
          sizeBytes: meta.sizeBytes ?? 0,
          createdAt: meta.createdAt,
        }),
      )
      .sort((a, b): number => b.createdAt.localeCompare(a.createdAt));
  }
  return listAttachmentsInDir(
    resolveAgentAttachmentsDir(projectId, worktreeId),
  );
}
