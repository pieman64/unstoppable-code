import { PORTAL_CATALOG_CONTENT_MAX_BYTES } from '@canopy/protocol/portal';
import {
  fitListResult,
  fitReadResult,
  truncateBodyToBytes,
} from './result-budget';
import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  WorkspaceNoteItem,
  PortalWorkspaceNoteItem,
  PortalWorkspaceAttachmentItem,
  PortalWorkspaceItemsListNotesResult,
  PortalWorkspaceItemsReadNoteResult,
  PortalWorkspaceItemsListPromptsResult,
  PortalWorkspaceItemsReadPromptResult,
  PortalWorkspaceItemsListAttachmentsResult,
} from '@canopy/desktop-shared/types';
import {
  listPortalWorkspaceAttachments,
  listPortalWorkspaceTextItems,
  readPortalWorkspaceTextItem,
} from '../portal-workspace-reads';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

/**
 * Fail a workspace-item read without echoing the underlying filesystem error.
 *
 * These commands resolve a browser-supplied id onto a local path, so a Node
 * filesystem error (`ENOENT: ... open '/Users/.../notes/x.md'`) would put the
 * user's absolute paths on the wire. The code is preserved so the browser can
 * still distinguish a missing item; the detail stays in the local log.
 */
function failWorkspaceItemError(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  error: unknown,
  message: string,
): void {
  const code: unknown =
    error instanceof Error && 'code' in error ? error.code : undefined;
  if (typeof code === 'string') {
    logMainProcessWarn('[portal] project item read failed', error);
    context.fail(command, code, message, false);
    return;
  }
  failServiceError(command, context, error);
}

/**
 * Project a desktop note/prompt onto its wire shape. Notes and prompts share
 * one structure, so one projector serves both.
 *
 * Field-by-field on purpose: the wire types omit `absolutePath`, a local
 * filesystem path with no meaning in a browser, and a spread would leak it.
 */
function projectWorkspaceItem(
  item: WorkspaceNoteItem,
): PortalWorkspaceNoteItem {
  const result: PortalWorkspaceNoteItem = {
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.origin) {
    result.origin = {
      worktreeId: item.origin.worktreeId,
      branchName: item.origin.branchName,
      worktreeExists: item.origin.worktreeExists,
    };
  }
  return result;
}

export async function handlePortalWorkspaceItemsListNotes(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace_items.list_notes']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project items list notes payload.',
    );
    return;
  }
  try {
    // core.workspace.item.list
    const value = await listPortalWorkspaceTextItems(
      'note',
      command.payload.projectId,
    );
    const result = fitListResult(
      value.map(projectWorkspaceItem),
      (rows, truncated): PortalWorkspaceItemsListNotesResult => ({
        ok: true,
        notes: rows,
        ...(truncated ? { truncated: true } : {}),
      }),
    );
    context.complete(command, result);
  } catch (error) {
    failWorkspaceItemError(
      command,
      context,
      error,
      "Couldn't load the project items.",
    );
  }
}

export async function handlePortalWorkspaceItemsReadNote(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace_items.read_note']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project items read note payload.',
    );
    return;
  }
  try {
    // core.workspace.item.get
    const value = await readPortalWorkspaceTextItem(
      'note',
      command.payload.projectId,
      command.payload.noteId,
    );
    const { body, truncated } = truncateBodyToBytes(
      value.content,
      PORTAL_CATALOG_CONTENT_MAX_BYTES,
    );
    const result: PortalWorkspaceItemsReadNoteResult = {
      ok: true,
      meta: projectWorkspaceItem(value.meta),
      content: body,
      truncated,
    };
    context.complete(
      command,
      fitReadResult(
        result,
        (current): string => current.content,
        (current, content, cut): PortalWorkspaceItemsReadNoteResult => ({
          ...current,
          content,
          truncated: current.truncated || cut,
        }),
      ),
    );
  } catch (error) {
    failWorkspaceItemError(
      command,
      context,
      error,
      "Couldn't read the project item.",
    );
  }
}

export async function handlePortalWorkspaceItemsListPrompts(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace_items.list_prompts']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project items list prompts payload.',
    );
    return;
  }
  try {
    // core.workspace.item.list
    const value = await listPortalWorkspaceTextItems(
      'prompt',
      command.payload.projectId,
    );
    const result = fitListResult(
      value.map(projectWorkspaceItem),
      (rows, truncated): PortalWorkspaceItemsListPromptsResult => ({
        ok: true,
        prompts: rows,
        ...(truncated ? { truncated: true } : {}),
      }),
    );
    context.complete(command, result);
  } catch (error) {
    failWorkspaceItemError(
      command,
      context,
      error,
      "Couldn't load the project items.",
    );
  }
}

export async function handlePortalWorkspaceItemsReadPrompt(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace_items.read_prompt']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project items read prompt payload.',
    );
    return;
  }
  try {
    // core.workspace.item.get
    const value = await readPortalWorkspaceTextItem(
      'prompt',
      command.payload.projectId,
      command.payload.promptId,
    );
    const { body, truncated } = truncateBodyToBytes(
      value.content,
      PORTAL_CATALOG_CONTENT_MAX_BYTES,
    );
    const result: PortalWorkspaceItemsReadPromptResult = {
      ok: true,
      meta: projectWorkspaceItem(value.meta),
      content: body,
      truncated,
    };
    context.complete(
      command,
      fitReadResult(
        result,
        (current): string => current.content,
        (current, content, cut): PortalWorkspaceItemsReadPromptResult => ({
          ...current,
          content,
          truncated: current.truncated || cut,
        }),
      ),
    );
  } catch (error) {
    failWorkspaceItemError(
      command,
      context,
      error,
      "Couldn't read the project item.",
    );
  }
}

export async function handlePortalWorkspaceItemsListAttachments(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.workspace_items.list_attachments']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid project items list attachments payload.',
    );
    return;
  }
  try {
    // core.workspace.item.list
    const value = await listPortalWorkspaceAttachments(
      command.payload.projectId,
      command.payload.worktreeId,
    );
    const result = fitListResult(
      value.map(
        (item): PortalWorkspaceAttachmentItem => ({
          filename: item.filename,
          sizeBytes: item.sizeBytes,
          createdAt: item.createdAt,
        }),
      ),
      (rows, truncated): PortalWorkspaceItemsListAttachmentsResult => ({
        ok: true,
        attachments: rows,
        ...(truncated ? { truncated: true } : {}),
      }),
    );
    context.complete(command, result);
  } catch (error) {
    failWorkspaceItemError(
      command,
      context,
      error,
      "Couldn't load the project items.",
    );
  }
}
