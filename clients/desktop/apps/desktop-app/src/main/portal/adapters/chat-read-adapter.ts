import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  type ChatCommandRequest,
  type PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { validateId } from '../../lib/validation';
import { projectPersistedChatTranscript } from '../../services/chat-transcript-projector';
import {
  emitStandaloneChatSummary,
  resolveStandaloneChatTarget,
} from '../../services/standalone-chat-service';
import { isRecord } from './validation';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import type { PortalAdapterContext } from './types';
import { queryPortalChatState } from './chat-state-query';

interface PortalChatReadTarget {
  scope: 'worktree' | 'standalone';
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Validates the worktree/standalone target shared by the read-state commands
 * and resolves a standalone chat to its owning entry. Fails the command and
 * returns undefined when the target is invalid, embedded, or missing.
 */
async function resolvePortalChatReadTarget(
  command: PortalCommandEnvelope<unknown>,
  payload: Record<string, unknown>,
  context: PortalAdapterContext,
): Promise<PortalChatReadTarget | undefined> {
  const { chatId } = payload;
  try {
    if (typeof chatId !== 'string') throw new Error('Missing chat');
    validateId(chatId, 'chatId');
    if (payload.scope === 'worktree') {
      if (
        typeof payload.projectId !== 'string' ||
        typeof payload.worktreeId !== 'string'
      )
        throw new Error('Invalid target');
      validateId(payload.projectId, 'projectId');
      validateId(payload.worktreeId, 'worktreeId');
      const projectId = payload.projectId;
      const worktreeId = payload.worktreeId;
      if (
        projectId === APP_ADVISOR_PROJECT_ID ||
        projectId === PIPELINE_EDITOR_PROJECT_ID
      )
        throw new Error('Embedded scope');
      if (
        (command.target?.workspaceLocalId &&
          command.target.workspaceLocalId !== projectId) ||
        (command.target?.worktreeLocalId &&
          command.target.worktreeLocalId !== worktreeId)
      )
        throw new Error('Target mismatch');
      return { scope: 'worktree', projectId, worktreeId, chatId };
    }
    if (payload.scope !== 'standalone') throw new Error('Invalid scope');
    if (typeof payload.projectLocalId !== 'string')
      throw new Error('Missing project');
    validateId(payload.projectLocalId, 'projectLocalId');
    if (
      command.target?.standaloneChatLocalId &&
      command.target.standaloneChatLocalId !== chatId
    )
      throw new Error('Target mismatch');
    const resolved = await resolveStandaloneChatTarget({
      projectLocalId: payload.projectLocalId,
      chatId,
    });
    if (!resolved.entryId || resolved.isArchived) {
      context.fail(command, 'not_found', 'The active chat was not found.');
      return undefined;
    }
    return {
      scope: 'standalone',
      projectId: resolved.workspaceId,
      worktreeId: resolved.entryId,
      chatId,
    };
  } catch {
    context.fail(command, 'invalid_payload', 'Invalid chat read target.');
    return undefined;
  }
}

/** Returns the chat state port, failing the command as retryable when absent. */
function requirePortalChatStatePort(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): PortalAdapterContext['chatStatePort'] {
  const port = context.chatStatePort;
  if (!port)
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
  return port;
}

/** Read acknowledgements never activate tabs or dismiss approval/attention state. */
export async function handlePortalChatMarkRead(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.chatId !== 'string' ||
    (payload.lastMessageId !== null &&
      (typeof payload.lastMessageId !== 'string' || !payload.lastMessageId)) ||
    !['worktree', 'standalone'].includes(String(payload.scope))
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid chat read acknowledgement.',
    );
    return;
  }
  const { lastMessageId } = payload;
  const target = await resolvePortalChatReadTarget(command, payload, context);
  if (!target) return;
  const { projectId, worktreeId, chatId } = target;
  const port = requirePortalChatStatePort(command, context);
  if (!port) return;
  try {
    const snapshot = await queryPortalChatState(context, {
      projectId,
      worktreeId,
    });
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === chatId && (candidate.kind ?? 'chat') === 'chat',
    );
    if (!tab) {
      context.fail(command, 'not_found', 'The chat was not found.');
      return;
    }
    if (!tab.unread) {
      context.complete(command, { ok: true, applied: false });
      return;
    }
    const runtime = snapshot.runtimeByChatId[chatId];
    const latestDisplayed = (
      messages: typeof tab.messages,
    ):
      | ReturnType<typeof projectPersistedChatTranscript>[number]
      | undefined => {
      const displayed = projectPersistedChatTranscript({
        scope: payload.scope === 'standalone' ? 'standalone' : 'worktree',
        chatId,
        messages,
        turnEnds: tab.turnEnds,
        unacceptedTurnEnds: tab.unacceptedTurnEnds,
        interruptedTurns: tab.interruptedTurns,
      }).filter(
        (message) =>
          message.text.length > 0 ||
          message.parts?.some((part) => part.kind !== 'turn_timer'),
      );
      return displayed[displayed.length - 1];
    };
    let latest;
    if (tab.transcript || tab.transcriptLoaded === false) {
      // Scope snapshots hydrate only the active tab. Read the acknowledged
      // chat explicitly, without activating it or loading sibling transcripts.
      let before: number | undefined;
      let transcriptRevision = tab.transcript?.transcriptRevision;
      do {
        if (!context.sessionId)
          throw new Error('Portal session is unavailable.');
        const { legacyResult: page } =
          await getActiveDesktopRuntime().queryChatTranscriptPageForLegacyIpc(
            {
              scope: { workspaceId: projectId, worktreeId, chatId },
              before,
              transcriptRevision,
            },
            {
              caller: {
                principalId: 'local-desktop-user',
                clientInstanceId: `portal-session:${context.sessionId}`,
                authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
                interfaceKind: 'portal',
                grants: ['core.chat.read'],
              },
            },
          );
        latest = latestDisplayed(page.messages);
        before = page.before;
        transcriptRevision = page.transcriptRevision;
      } while (!latest && before !== undefined);
    } else {
      latest = latestDisplayed(tab.messages);
    }
    if (
      (latest?.messageId ?? null) !== lastMessageId ||
      (runtime &&
        ['starting', 'streaming', 'completing'].includes(runtime.status))
    ) {
      // The phone acknowledged older output. Do not replay it against a later
      // revision; fresh visible output will produce a fresh acknowledgement.
      context.complete(command, { ok: true, applied: false });
      return;
    }
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: command.id,
      projectId,
      worktreeId,
      expectedRevision: snapshot.revision,
      origin: 'portal',
      command: { type: 'chat.mark_read', chatId },
    };
    const result = await (context.dispatchChatCommand
      ? context.dispatchChatCommand(request)
      : port.command(request));
    if (result.outcome === 'applied' || result.outcome === 'already_applied') {
      if (payload.scope === 'standalone') {
        // Cowork materialization updates the sidebar but does not itself emit
        // the standalone portal entity. Re-read the committed tab for the delta.
        await emitStandaloneChatSummary(projectId, worktreeId, chatId);
      }
      context.complete(command, result);
    } else {
      context.fail(
        command,
        result.outcome === 'conflict' ? 'conflict' : 'execution_failed',
        'The chat changed before the read acknowledgement was applied.',
        result.outcome === 'conflict',
      );
    }
  } catch {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
  }
}

/**
 * Explicit read state from a chat tab menu. An unread mark is recorded as
 * manual; neither direction checks staleness, because the user chose it.
 * A chat already in the requested state is a no-op (`applied: false`), even
 * when only the manual flag would differ.
 */
export async function handlePortalChatSetUnread(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  if (!isRecord(payload) || typeof payload.unread !== 'boolean') {
    context.fail(command, 'invalid_payload', 'Invalid chat read state.');
    return;
  }
  const unread = payload.unread;
  const target = await resolvePortalChatReadTarget(command, payload, context);
  if (!target) return;
  const { projectId, worktreeId, chatId } = target;
  const port = requirePortalChatStatePort(command, context);
  if (!port) return;
  try {
    const snapshot = await queryPortalChatState(context, {
      projectId,
      worktreeId,
    });
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === chatId && (candidate.kind ?? 'chat') === 'chat',
    );
    if (!tab) {
      context.fail(command, 'not_found', 'The chat was not found.');
      return;
    }
    if ((tab.unread === true) === unread) {
      context.complete(command, { ok: true, applied: false });
      return;
    }
    // No expected revision: main honors one on any Portal-origin mark_read
    // that supplies it, so an unrelated change in the worktree would turn the
    // user's explicit choice into a conflict.
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: command.id,
      projectId,
      worktreeId,
      origin: 'portal',
      command: unread
        ? { type: 'chat.mark_unread', chatId, manual: true }
        : { type: 'chat.mark_read', chatId },
    };
    const result = await (context.dispatchChatCommand
      ? context.dispatchChatCommand(request)
      : port.command(request));
    if (result.outcome === 'applied' || result.outcome === 'already_applied') {
      if (target.scope === 'standalone') {
        await emitStandaloneChatSummary(projectId, worktreeId, chatId);
      }
      context.complete(command, result);
    } else {
      context.fail(
        command,
        result.outcome === 'conflict' ? 'conflict' : 'execution_failed',
        result.outcome === 'conflict'
          ? 'The chat changed before its read state was updated.'
          : 'The chat read state could not be updated.',
        result.outcome === 'conflict',
      );
    }
  } catch {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
  }
}
