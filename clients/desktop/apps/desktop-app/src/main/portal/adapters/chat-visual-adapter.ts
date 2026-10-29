import { CanopyOperationError } from '@canopy/core-runtime';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  type PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import {
  PORTAL_CHAT_VISUAL_PAGE_BYTES,
  readPortalChatPartVisual,
  type PortalChatVisualReadPayload,
  type PortalChatVisualReference,
} from '@canopy/protocol/portal';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { validateId } from '../../lib/validation';
import { resolveStandaloneChatTarget } from '../../services/standalone-chat-service';
import { queryPortalChatState } from './chat-state-query';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';

const OPERATION = 'canopy.portal_chat_visual_read';

function validPayload(value: unknown): value is PortalChatVisualReadPayload {
  if (!isRecord(value)) return false;
  const {
    scope,
    chatId,
    messageId,
    toolUseId,
    reference,
    offset,
    limit,
    read,
  } = value;
  if (
    (scope !== 'worktree' && scope !== 'standalone') ||
    typeof chatId !== 'string' ||
    !chatId ||
    typeof messageId !== 'string' ||
    !messageId ||
    typeof toolUseId !== 'string' ||
    !toolUseId ||
    !Number.isSafeInteger(offset) ||
    typeof offset !== 'number' ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    typeof limit !== 'number' ||
    limit < 1 ||
    limit > PORTAL_CHAT_VISUAL_PAGE_BYTES ||
    !isRecord(read) ||
    typeof read.id !== 'string' ||
    !read.id ||
    typeof read.pageCount !== 'number' ||
    !Number.isSafeInteger(read.pageCount) ||
    read.pageCount < 1
  )
    return false;
  const visual = readPortalChatPartVisual({
    kind: 'tool_result',
    data: { visual: reference },
  });
  if (
    !visual ||
    (visual.byteLength === 0 ? offset !== 0 : offset >= visual.byteLength)
  )
    return false;
  try {
    validateId(chatId, 'chatId');
    if (scope === 'worktree') {
      if (
        typeof value.projectId !== 'string' ||
        typeof value.worktreeId !== 'string'
      )
        return false;
      validateId(value.projectId, 'projectId');
      validateId(value.worktreeId, 'worktreeId');
      if (
        value.projectId === APP_ADVISOR_PROJECT_ID ||
        value.projectId === PIPELINE_EDITOR_PROJECT_ID ||
        'projectLocalId' in value
      )
        return false;
    } else {
      if (
        typeof value.projectLocalId !== 'string' ||
        'projectId' in value ||
        'worktreeId' in value
      )
        return false;
      validateId(value.projectLocalId, 'projectLocalId');
    }
  } catch {
    return false;
  }
  return true;
}

function mutableReference(reference: PortalChatVisualReference): Omit<
  PortalChatVisualReference,
  'heights'
> & {
  heights?: [number, number][];
} {
  const { heights, ...rest } = reference;
  return heights
    ? {
        ...rest,
        heights: heights.map(([width, height]): [number, number] => [
          width,
          height,
        ]),
      }
    : rest;
}

/** A page is sent live only; the store substitutes a retryable failure on disk. */
export async function handlePortalChatVisualRead(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  if (!validPayload(payload) || !context.sessionId) {
    context.fail(command, 'invalid_payload', 'Invalid visual read request.');
    return;
  }
  const operationKey = createDesktopInstrumentationOperationKey(
    `${context.sessionId}:${payload.read.id}`,
  );
  try {
    // A chat archived on its own stays in its worktree's or entry's archive
    // file, which the live scope reads; only a whole archived container uses
    // the separate container store, and the Portal does not show those.
    let workspaceId: string;
    let worktreeId: string;
    let standaloneHistory: true | undefined;
    if (payload.scope === 'worktree') {
      if (
        (command.target?.workspaceLocalId &&
          command.target.workspaceLocalId !== payload.projectId) ||
        (command.target?.worktreeLocalId &&
          command.target.worktreeLocalId !== payload.worktreeId)
      ) {
        context.fail(command, 'invalid_target', 'Invalid visual read target.');
        return;
      }
      workspaceId = payload.projectId;
      worktreeId = payload.worktreeId;
      const snapshot = await queryPortalChatState(context, {
        projectId: workspaceId,
        worktreeId,
      });
      if (
        !snapshot.archives.some(
          (archive) => archive.chatId === payload.chatId,
        ) &&
        !snapshot.tabsFile.tabs.some((tab) => tab.id === payload.chatId)
      ) {
        context.fail(command, 'not_found', 'The visual was not found.');
        return;
      }
    } else {
      if (
        command.target?.standaloneChatLocalId &&
        command.target.standaloneChatLocalId !== payload.chatId
      ) {
        context.fail(command, 'invalid_target', 'Invalid visual read target.');
        return;
      }
      const resolved = await resolveStandaloneChatTarget({
        projectLocalId: payload.projectLocalId,
        chatId: payload.chatId,
      });
      workspaceId = resolved.workspaceId;
      worktreeId = resolved.entryId ?? resolved.archivedInEntryId ?? '';
      if (!worktreeId) {
        if (!resolved.isArchived) {
          context.fail(command, 'not_found', 'The visual was not found.');
          return;
        }
        // Retained pre-entry Cowork history is read through its legacy scope.
        worktreeId = COWORK_HOME_WORKTREE_ID;
        standaloneHistory = true;
      }
    }
    if (payload.offset === 0) {
      startDesktopOperation(OPERATION, { operationKey });
    }
    // The active runtime accessor is the dispatcher itself.
    const result = await getActiveDesktopRuntime().query(
      'core.chat.visual.read',
      {
        scope: { workspaceId, worktreeId, chatId: payload.chatId },
        ...(standaloneHistory ? { standaloneHistory } : {}),
        messageId: payload.messageId,
        toolUseId: payload.toolUseId,
        reference: mutableReference(payload.reference),
        offset: payload.offset,
        limit: payload.limit,
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: `portal-session:${context.sessionId}`,
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'portal',
          grants: ['core.chat.read'],
        },
        signal: new AbortController().signal,
      },
    );
    context.complete(command, { kind: 'inline-page', ...result });
    if (payload.offset + result.length === result.byteLength) {
      succeedDesktopOperation(OPERATION, {
        operationKey,
        context: {
          page_count: payload.read.pageCount,
          size_bytes: result.byteLength,
          transport_type: 'portal_inline',
        },
      });
    }
  } catch (error) {
    const kind =
      error instanceof CanopyOperationError ? error.payload.kind : null;
    if (kind === 'not_found')
      context.fail(command, 'not_found', 'The visual was not found.');
    else if (kind === 'failed_precondition')
      context.fail(
        command,
        'execution_failed',
        'The visual is no longer available.',
      );
    else
      context.fail(
        command,
        'execution_failed',
        'The visual could not be read.',
      );
  }
}
