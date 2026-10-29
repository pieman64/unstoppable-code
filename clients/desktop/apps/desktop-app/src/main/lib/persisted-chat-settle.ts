import type {
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { withInterruptedTurn } from './chat-turn-succession';

/**
 * Close every open `turn_timer` block. Used when a transcript leaves live
 * streaming ownership (archive of an interrupted chat, fork of a streaming
 * source) so the copy never renders a running timer.
 */
export function closeOpenPersistedTurnTimers(
  messages: PersistedChatMessage[],
  completedAt: number,
): PersistedChatMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'turn_timer' || block.completedAt !== null) {
        return block;
      }
      changed = true;
      messageChanged = true;
      return { ...block, completedAt };
    });
    return messageChanged ? { ...message, blocks } : message;
  });
  return changed ? result : messages;
}

interface SettleToolResultGroup {
  parentToolUseId?: string;
  parentBlockId?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  blocks: PersistedChatBlock[];
}

function settleToolResultGroupKey(message: PersistedChatMessage): string {
  const parentKey =
    message.parentBlockId !== undefined
      ? `block:${message.parentBlockId}|tool:${message.parentToolUseId ?? ''}`
      : `tool:${message.parentToolUseId ?? ''}`;
  return [
    parentKey,
    `codexThread:${message.codexThreadId ?? ''}`,
    `codexTurn:${message.codexTurnId ?? ''}`,
  ].join('|');
}

/**
 * Append error `tool_result` blocks for every `tool_use` that never received
 * one, grouped so nested/codex results keep their parent identity. `output`
 * names the reason the tool never completed (e.g. `Cancelled`).
 */
export function closeOpenPersistedToolUses(
  messages: PersistedChatMessage[],
  completedAt: number,
  output = 'Cancelled',
): PersistedChatMessage[] {
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId);
      }
    }
  }

  const unmatchedByParent = new Map<string, SettleToolResultGroup>();
  const unmatchedGroups: SettleToolResultGroup[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || toolResultIds.has(block.toolUseId)) {
        continue;
      }
      const key = settleToolResultGroupKey(message);
      let entry = unmatchedByParent.get(key);
      if (!entry) {
        entry = {
          ...(message.parentToolUseId
            ? { parentToolUseId: message.parentToolUseId }
            : {}),
          ...(message.parentBlockId
            ? { parentBlockId: message.parentBlockId }
            : {}),
          ...(message.codexThreadId
            ? { codexThreadId: message.codexThreadId }
            : {}),
          ...(message.codexTurnId ? { codexTurnId: message.codexTurnId } : {}),
          blocks: [],
        };
        unmatchedByParent.set(key, entry);
        unmatchedGroups.push(entry);
      }
      entry.blocks.push({
        type: 'tool_result',
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        output,
        isError: true,
      });
    }
  }

  if (unmatchedByParent.size === 0) {
    return messages;
  }

  const result = [...messages];
  let index = 0;
  for (const entry of unmatchedGroups) {
    result.push({
      id: `archive-cancel-${completedAt}-${index}`,
      role: 'system',
      timestamp: completedAt,
      ...(entry.parentToolUseId
        ? { parentToolUseId: entry.parentToolUseId }
        : {}),
      ...(entry.parentBlockId ? { parentBlockId: entry.parentBlockId } : {}),
      ...(entry.codexThreadId ? { codexThreadId: entry.codexThreadId } : {}),
      ...(entry.codexTurnId ? { codexTurnId: entry.codexTurnId } : {}),
      blocks: entry.blocks,
    });
    index += 1;
  }
  return result;
}

/**
 * Settle a transcript snapshot cloned out of a still-streaming source: close
 * open timers and mark unfinished tool uses as interrupted, so the copy is an
 * idle, independently editable record while the original turn continues.
 */
export function settlePersistedForkMessages(
  messages: PersistedChatMessage[],
  completedAt: number,
): PersistedChatMessage[] {
  return closeOpenPersistedToolUses(
    closeOpenPersistedTurnTimers(messages, completedAt),
    completedAt,
    'Interrupted by fork',
  );
}

/**
 * Atomically settle a transcript and its runtime when live host ownership is
 * lost. Only changed or appended messages are upserted so restart recovery
 * does not rewrite an otherwise unchanged transcript.
 */
export function buildPersistedTurnInterruptedMutations(
  chatId: string,
  messages: PersistedChatMessage[],
  runtime: ChatRuntimeState,
  completedAt: number,
  queuedMessageIds: string[] = runtime.queuedMessageIds,
  tab?: Pick<PersistedChatTab, 'id' | 'interruptedTurns'>,
): ChatCoreMutation[] {
  const settledMessages = closeOpenPersistedToolUses(
    closeOpenPersistedTurnTimers(messages, completedAt),
    completedAt,
    'Interrupted by app restart',
  );
  const mutations: ChatCoreMutation[] = settledMessages.flatMap(
    (message, index) =>
      message === messages[index]
        ? []
        : [{ type: 'message.upserted' as const, chatId, message }],
  );
  if (tab && runtime.activeTurn) {
    mutations.push({
      type: 'tab.metadata_patched',
      tabId: tab.id,
      patch: {
        interruptedTurns: withInterruptedTurn(
          tab.interruptedTurns,
          runtime.activeTurn.userMessageId,
        ),
      },
    });
  }
  const settledRuntime = { ...runtime };
  delete settledRuntime.activeTurn;
  delete settledRuntime.deferredToolsReload;
  mutations.push({
    type: 'runtime.patched',
    chatId,
    runtime: {
      ...settledRuntime,
      status: 'interrupted',
      queuedMessageIds,
      lastActivityAt: completedAt,
      error: {
        code: 'interrupted',
        message: 'The provider turn was interrupted by an app restart.',
        retryable: true,
        occurredAt: new Date(completedAt).toISOString(),
      },
    },
  });
  return mutations;
}

/** Migration counterpart: retain one body at a time and only tool identities
 * between passes. The factory must return the same recovered source each time.
 */
export async function* settlePersistedInterruptedStream(
  messages: () => AsyncIterable<PersistedChatMessage>,
  completedAt: number,
): AsyncGenerator<PersistedChatMessage> {
  const completed = new Set<string>();
  for await (const message of messages()) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') completed.add(block.toolUseId);
    }
  }
  const unmatched: PersistedChatMessage[] = [];
  for await (const message of messages()) {
    const blocks: PersistedChatBlock[] = [];
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && !completed.has(block.toolUseId)) {
        // Settlement needs routing and identity, never the potentially huge
        // tool input or the surrounding message body.
        blocks.push({
          type: 'tool_use',
          toolUseId: block.toolUseId,
          toolName: block.toolName,
          input: '{}',
        });
      }
    }
    if (blocks.length)
      unmatched.push({
        id: message.id,
        role: message.role,
        timestamp: message.timestamp,
        parentToolUseId: message.parentToolUseId,
        parentBlockId: message.parentBlockId,
        codexThreadId: message.codexThreadId,
        codexTurnId: message.codexTurnId,
        blocks,
      });
    yield closeOpenPersistedTurnTimers([message], completedAt)[0];
  }
  const settled = closeOpenPersistedToolUses(
    unmatched,
    completedAt,
    'Interrupted by app restart',
  );
  for (let i = unmatched.length; i < settled.length; i++) yield settled[i];
}
