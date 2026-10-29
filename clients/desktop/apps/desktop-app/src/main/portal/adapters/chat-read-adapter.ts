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
  const { chatId, lastMessageId } = payload;
  let projectId: string;
  let worktreeId: string;
  try {
    validateId(chatId, 'chatId');
    if (payload.scope === 'worktree') {
      if (
        typeof payload.projectId !== 'string' ||
        typeof payload.worktreeId !== 'string'
      )
        throw new Error('Invalid target');
      validateId(payload.projectId, 'projectId');
      validateId(payload.worktreeId, 'worktreeId');
      projectId = payload.projectId;
      worktreeId = payload.worktreeId;
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
    } else {
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
        return;
      }
      projectId = resolved.workspaceId;
      worktreeId = resolved.entryId;
    }
  } catch {
    context.fail(command, 'invalid_payload', 'Invalid chat read target.');
    return;
  }
  const port = context.chatStatePort;
  if (!port) {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return;
  }
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
