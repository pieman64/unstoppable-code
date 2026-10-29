import { randomUUID } from 'node:crypto';
import type {
  ChatCommandEnvelope,
  ChatCommandResult,
} from '@canopy/desktop-shared/types';
import type { ProviderEventInput } from './chat-state-service';
import { logMainProcessWarn } from '../lib/main-process-logging';

/** The existing dispatch owners supply their canonical state capability. */
export async function closeRejectedSplitAgentStartup(
  target: Pick<ProviderEventInput, 'projectId' | 'worktreeId' | 'chatId'>,
  error: unknown,
  state: {
    ingestProviderEvent(input: ProviderEventInput): Promise<unknown>;
    command(envelope: ChatCommandEnvelope): Promise<ChatCommandResult>;
    settleRejectedStartup(
      target: Pick<ProviderEventInput, 'projectId' | 'worktreeId' | 'chatId'>,
      message: string,
    ): Promise<void>;
  },
): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  // Recovery may have launched a replacement query before dispatch rejected.
  // Resolve lazily because provider sessions also start independent chats.
  let stopped = false;
  try {
    const { destroySession } = await import('../agents/session-manager');
    await destroySession(target.projectId, target.worktreeId, target.chatId);
    stopped = true;
  } catch (stopError) {
    logMainProcessWarn(
      '[split-agent] Failed to stop rejected startup',
      stopError,
    );
  }
  try {
    await state.ingestProviderEvent({
      ...target,
      data: { type: 'error', error: message },
    });
  } catch (recordError) {
    // A failed fork may never have published a tab. Error recording must not
    // prevent closing an existing tab or accepting a canonical not_found.
    logMainProcessWarn(
      '[split-agent] Failed to record rejected startup',
      recordError,
    );
    try {
      if (stopped) await state.settleRejectedStartup(target, message);
    } catch (settleError) {
      logMainProcessWarn(
        '[split-agent] Failed to settle rejected startup',
        settleError,
      );
    }
  }
  try {
    const { chatId, ...scope } = target;
    const closed = await state.command({
      schemaVersion: 1,
      commandId: randomUUID(),
      ...scope,
      command: { type: 'chat.close_tab', tabId: chatId, mode: 'archive' },
    });
    if (closed.outcome !== 'applied' && closed.outcome !== 'not_found') {
      throw new Error(closed.reason ?? 'Failed startup cleanup was rejected');
    }
  } catch (cleanupError) {
    logMainProcessWarn(
      '[split-agent] Failed to close rejected startup',
      cleanupError,
    );
    throw new Error(
      `${message} The failed chat could not be closed. Close it before retrying.`,
    );
  }
  throw error;
}
