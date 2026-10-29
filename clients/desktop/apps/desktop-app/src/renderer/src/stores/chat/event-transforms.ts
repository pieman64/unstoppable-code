// Chat-event application to tabs: turn timers, tool-use closing, terminal
// field cleanup, and App Advisor mirror tab transforms.
import { appendSentAsMessageFallbackMarker } from '@canopy/desktop-shared/lib/ask-user-answers';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
} from '@/lib/transcript-parser';
export {
  pauseOpenTurnTimer,
  pauseTurnTimerBlock,
  resumePausedTurnTimer,
  resumeTurnTimerBlock,
} from '@/lib/transcript-parser';
import { attachAuthFailureToMessages } from '@canopy/agent-transcript';
import { isAskUserQuestionToolName } from '@/lib/canopy-tool-aliases';
import {
  AI_CREDITS_ROUTING_STATUS_EVENT_TYPE,
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  type CanopyAuthFailureEventData,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { isCanopyAuthFailureEventData } from '@canopy/protocol/auth-recovery';
import { isGatewayOnlyModel } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { normalizePersistedUsage } from '@/lib/chatUsageNormalization';
import type { ChatBlock, ChatMessage, ChatTab, PendingQuestion } from './types';
import { isRecord } from './utils';
import { nextMsgId } from './ids';
import { hasUnresolvedToolUse } from './messages';

export { hasUnresolvedToolUse } from './messages';

function getPersistedPromptMessages(
  data: Record<string, unknown>,
): PersistedChatMessage[] {
  const messages = data.canopy_persisted_messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is PersistedChatMessage =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      (message.role === 'user' ||
        message.role === 'assistant' ||
        message.role === 'system') &&
      typeof message.timestamp === 'number' &&
      Array.isArray(message.blocks),
  );
}

function mergePersistedPromptMessages(
  messages: ChatMessage[],
  persistedMessages: PersistedChatMessage[],
): ChatMessage[] {
  if (persistedMessages.length === 0) return messages;
  const replacements = new Map(
    persistedMessages.map((message) => [message.id, message]),
  );
  const merged = messages.map(
    (message) => replacements.get(message.id) ?? message,
  );
  const existingIds = new Set(messages.map((message) => message.id));
  for (const message of persistedMessages) {
    if (!existingIds.has(message.id)) merged.push(message);
  }
  return merged;
}

/**
 * Narrow a raw chat event down to the structured auth-failure shape
 * (`CANOPY_AUTH_FAILURE_EVENT_TYPE`, Task 7) before trusting its fields.
 *
 * The shape + invariant guard itself lives in `@canopy/protocol` so this
 * renderer boundary, the `@canopy/agent-transcript` reducer, and the web
 * Portal all deserialize the wire value through one implementation.
 */
export function isAuthFailureEventData(
  data: Record<string, unknown>,
): data is Record<string, unknown> & CanopyAuthFailureEventData {
  return isCanopyAuthFailureEventData(data);
}

/**
 * Re-exported from `@canopy/agent-transcript` so the renderer store, the
 * transcript reducer (which persists the field through main), and the Portal
 * all share one attach implementation (CAN-1814).
 */
export {
  attachAuthFailureToBlocks,
  attachAuthFailureToMessages,
} from '@canopy/agent-transcript';

export function applyTabEvent(
  tab: ChatTab,
  data: Record<string, unknown>,
): ChatTab {
  const type = typeof data.type === 'string' ? data.type : '';
  if (type === CANOPY_AUTH_FAILURE_EVENT_TYPE) {
    if (!isAuthFailureEventData(data)) return tab;
    const messages = attachAuthFailureToMessages(tab.messages, data);
    // Identity matters here: `applyTabEvent` feeds memoized turn-group caches,
    // so a `toolUseId` that matched nothing must not mint a fresh tab object.
    if (messages === tab.messages) return tab;
    return { ...tab, messages };
  }
  const now = Date.now();
  const routingStatus =
    type === AI_CREDITS_ROUTING_STATUS_EVENT_TYPE &&
    typeof data.active === 'boolean'
      ? data.active
      : undefined;
  const aiCreditsRouted =
    routingStatus ??
    tab.aiCreditsRouted ??
    (tab.aiCreditsRouting?.active === true ||
      (tab.model !== undefined && isGatewayOnlyModel(tab.model)));
  const tabWithRoutingState =
    routingStatus === undefined
      ? tab
      : {
          ...tab,
          aiCreditsRouted: routingStatus,
          accountProxyRouted: data.accountProxyRouted === true,
          usage: normalizePersistedUsage(tab.usage, tab.model, routingStatus),
        };
  const persistedPromptMessages =
    type === 'canopy_user_prompt' ? getPersistedPromptMessages(data) : [];
  const tabWithPersistedPromptMessages =
    persistedPromptMessages.length > 0
      ? {
          ...tabWithRoutingState,
          messages: mergePersistedPromptMessages(
            tab.messages,
            persistedPromptMessages,
          ),
        }
      : tabWithRoutingState;

  if (type === 'codex') {
    const event = isRecord(data.event) ? data.event : null;
    if (!event) {
      return tab;
    }

    const reduced = applyCodexTranscriptEvent(
      tabWithPersistedPromptMessages,
      event,
      {
        now,
        createMessageId: nextMsgId,
        aiCreditsRouted,
      },
    );
    return reduced === tabWithPersistedPromptMessages
      ? tabWithPersistedPromptMessages
      : { ...tabWithPersistedPromptMessages, ...reduced };
  }

  const reduced = applyClaudeTranscriptEvent(
    tabWithPersistedPromptMessages,
    data,
    {
      now,
      createMessageId: nextMsgId,
      aiCreditsRouted,
    },
  );
  const applied =
    reduced === tabWithPersistedPromptMessages
      ? tabWithPersistedPromptMessages
      : { ...tabWithPersistedPromptMessages, ...reduced };
  const appliedWithForkContext =
    data.canopy_fork_model_context === 'fresh' && applied.forkedFrom
      ? {
          ...applied,
          forkedFrom: { ...applied.forkedFrom, modelContext: 'fresh' as const },
        }
      : applied;
  if (
    data.type === 'system' &&
    data.subtype === 'init' &&
    typeof data.session_id === 'string' &&
    appliedWithForkContext.providerType === 'codex' &&
    appliedWithForkContext.codexReconstructionSeedId
  ) {
    return {
      ...appliedWithForkContext,
      codexReconstructionSeedId: undefined,
    };
  }
  if (
    data.type === 'system' &&
    data.subtype === 'init' &&
    typeof data.session_id === 'string' &&
    data.session_id !== tab.sdkSessionId &&
    appliedWithForkContext.claudeForkSessionOnNextSend
  ) {
    return {
      ...appliedWithForkContext,
      claudeForkSessionOnNextSend: undefined,
      ...(appliedWithForkContext.forkedFrom?.resumePointRequired === true
        ? {
            forkedFrom: {
              ...appliedWithForkContext.forkedFrom,
              resumePointRequired: undefined,
            },
          }
        : {}),
    };
  }
  return appliedWithForkContext;
}

export function applyAppAdvisorMirrorNavEvent(
  tab: ChatTab,
  data: Record<string, unknown>,
): ChatTab {
  let status = tab.status;

  if (data.type === 'codex') {
    const event = isRecord(data.event) ? data.event : null;
    switch (event?.type) {
      case 'turn.started':
        status = 'streaming';
        break;
      case 'turn.completed':
        status = 'idle';
        break;
      case 'turn.failed':
      case 'error':
        status = 'error';
        break;
    }
  } else {
    switch (data.type) {
      case 'canopy_user_prompt':
      case 'assistant':
      case 'user':
        status = 'streaming';
        break;
      case 'result':
        status =
          data.is_error === true
            ? 'error'
            : data.canopy_session_continues === true
              ? 'streaming'
              : 'idle';
        break;
      case 'error':
        status = 'error';
        break;
    }
  }

  return applyAppAdvisorMirrorNavFields(tab, { ...tab, status });
}

export function applyAppAdvisorMirrorNavFields(
  tab: ChatTab,
  source: ChatTab,
): ChatTab {
  let changed = false;
  const next: ChatTab = { ...tab };

  if (next.status !== source.status) {
    next.status = source.status;
    changed = true;
  }

  if (next.description !== source.description) {
    if (source.description === undefined) {
      delete next.description;
    } else {
      next.description = source.description;
    }
    changed = true;
  }

  return changed ? next : tab;
}

export function createAppAdvisorMirrorTab(chatId: string): ChatTab {
  return {
    id: chatId,
    title: 'App Advisor',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: new Date().toISOString(),
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
  };
}

export function clearTerminalFields(
  tab: ChatTab,
  options: {
    isTerminal: boolean;
    stickyReview: boolean;
    planProposal: boolean;
  },
): ChatTab {
  if (!options.isTerminal) {
    return tab;
  }

  const shouldClearPendingPlanExit =
    !options.stickyReview && !options.planProposal;
  const nextPendingPlanExit = shouldClearPendingPlanExit
    ? undefined
    : tab.pendingPlanExit;

  if (
    tab.currentTodos === undefined &&
    tab.currentTaskTodos === undefined &&
    tab.pendingPlanExit === nextPendingPlanExit
  ) {
    return tab;
  }

  return {
    ...tab,
    pendingPlanExit: nextPendingPlanExit,
    currentTodos: undefined,
    currentTaskTodos: undefined,
  };
}

export function clearForcedQueueFields(
  tab: ChatTab,
  options: { isTerminal: boolean; isCancellationTerminal: boolean },
): ChatTab {
  if (!options.isTerminal || options.isCancellationTerminal) {
    return tab;
  }

  if (
    tab.forceQueuedMessageCancelPending === undefined &&
    tab.ignoreNextCancellationTerminal === undefined
  ) {
    return tab;
  }

  return {
    ...tab,
    forceQueuedMessageCancelPending: undefined,
    ignoreNextCancellationTerminal: undefined,
  };
}

export function completeTurnTimer(
  messages: ChatMessage[],
  completedAt: number = Date.now(),
): ChatMessage[] {
  // Find the last turn_timer message and set its completedAt
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const timerBlock = msg.blocks.find(
      (b): b is ChatBlock & { type: 'turn_timer' } => b.type === 'turn_timer',
    );
    if (
      timerBlock &&
      timerBlock.completedAt === null &&
      (timerBlock.pausedAt == null || timerBlock.resumedAt != null)
    ) {
      const updatedBlocks = msg.blocks.map((b) =>
        b.type === 'turn_timer' &&
        b.completedAt === null &&
        (b.pausedAt == null || b.resumedAt != null)
          ? { ...b, completedAt }
          : b,
      );
      const updated = [...messages];
      updated[i] = { ...msg, blocks: updatedBlocks };
      return updated;
    }
  }
  return messages;
}

export function appendStaleAskUserAnswerResult(
  messages: ChatMessage[],
  pending: PendingQuestion,
  fallbackMessageText: string,
): { messages: ChatMessage[]; appended: boolean } {
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId);
      }
    }
  }

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (!isAskUserQuestionToolName(block.toolName)) {
        continue;
      }
      if (toolResultIds.has(block.toolUseId)) {
        continue;
      }
      if (pending.toolUseId && block.toolUseId !== pending.toolUseId) {
        continue;
      }

      return {
        appended: true,
        messages: [
          ...messages,
          {
            id: nextMsgId(),
            role: 'system',
            timestamp: Date.now(),
            ...(message.parentToolUseId
              ? { parentToolUseId: message.parentToolUseId }
              : {}),
            ...(message.parentBlockId
              ? { parentBlockId: message.parentBlockId }
              : {}),
            blocks: [
              {
                type: 'tool_result',
                toolUseId: block.toolUseId,
                toolName: block.toolName,
                output: appendSentAsMessageFallbackMarker(fallbackMessageText),
                isError: false,
              },
            ],
          },
        ],
      };
    }
  }

  return { messages, appended: false };
}

/**
 * Add synthetic tool_result blocks for any tool_use that never received a
 * result (e.g. because the session was cancelled mid-execution).
 */
export function closeOpenToolUseBlocks(
  messages: ChatMessage[],
  options: {
    output?: string;
    isError?: boolean;
  } = {},
): ChatMessage[] {
  const output = options.output ?? 'Cancelled';
  const isError = options.isError ?? false;
  // Collect all tool_result IDs (including from subagent messages)
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId);
      }
    }
  }

  // Find tool_use blocks without matching tool_result, grouped by parent block.
  const unmatchedByParent = new Map<
    string,
    {
      parentToolUseId?: string;
      parentBlockId?: string;
      blocks: ChatBlock[];
    }
  >();
  for (const msg of messages) {
    for (const block of msg.blocks) {
      // `codex_agent_call` blocks intentionally pass through unchanged —
      // they are Codex-native display blocks whose lifecycle is driven by
      // `agentsStates` updates, NOT by a paired tool_result. Synthesizing a
      // `tool_result` for them would corrupt the persisted block, so this
      // cancel-out path must skip them explicitly.
      if (block.type === 'codex_agent_call') {
        continue;
      }
      if (block.type === 'tool_use' && !toolResultIds.has(block.toolUseId)) {
        const key =
          msg.parentBlockId !== undefined
            ? `block:${msg.parentBlockId}|tool:${msg.parentToolUseId ?? ''}`
            : `tool:${msg.parentToolUseId ?? ''}`;
        const entry = unmatchedByParent.get(key) ?? {
          ...(msg.parentToolUseId
            ? { parentToolUseId: msg.parentToolUseId }
            : {}),
          ...(msg.parentBlockId ? { parentBlockId: msg.parentBlockId } : {}),
          blocks: [],
        };
        entry.blocks.push({
          type: 'tool_result',
          toolUseId: block.toolUseId,
          toolName: block.toolName,
          output,
          isError,
        });
        unmatchedByParent.set(key, entry);
      }
    }
  }

  if (unmatchedByParent.size === 0) return messages;

  // Add synthetic tool_result messages
  const result = [...messages];
  unmatchedByParent.forEach((entry) => {
    const syntheticMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'system',
      blocks: entry.blocks,
      timestamp: Date.now(),
      ...(entry.parentToolUseId
        ? { parentToolUseId: entry.parentToolUseId }
        : {}),
      ...(entry.parentBlockId ? { parentBlockId: entry.parentBlockId } : {}),
    };
    result.push(syntheticMsg);
  });

  return result;
}

export function ensureForkSnapshotTurnTimer(
  messages: ChatMessage[],
): ChatMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) {
    return messages;
  }

  const hasTurnTimerForLatestTurn = messages
    .slice(latestUserIndex + 1)
    .some((message) =>
      message.blocks.some((block) => block.type === 'turn_timer'),
    );
  if (hasTurnTimerForLatestTurn) {
    return messages;
  }

  const completedAt = Date.now();
  const latestUserMessage = messages[latestUserIndex];
  const startedAt =
    typeof latestUserMessage?.timestamp === 'number'
      ? latestUserMessage.timestamp
      : completedAt;
  return [
    ...messages,
    {
      id: nextMsgId(),
      role: 'system',
      timestamp: completedAt,
      blocks: [
        {
          type: 'turn_timer',
          startedAt,
          completedAt,
        },
      ],
    },
  ];
}

export function settleForkSnapshotMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return ensureForkSnapshotTurnTimer(
    closeOpenToolUseBlocks(
      closeOpenTurnTimers(messages, { closePaused: true }),
      {
        output: 'Interrupted by fork',
        isError: true,
      },
    ),
  );
}

/** Close ALL open turn_timer blocks (used when restoring persisted state). */
export function closeOpenTurnTimers(
  messages: ChatMessage[],
  options?: { closePaused?: boolean },
): ChatMessage[] {
  let changed = false;
  const result = messages.map((msg) => {
    const hasOpen = msg.blocks.some(
      (b) =>
        b.type === 'turn_timer' &&
        b.completedAt === null &&
        (options?.closePaused || b.pausedAt == null || b.resumedAt != null),
    );
    if (!hasOpen) return msg;
    changed = true;
    return {
      ...msg,
      blocks: msg.blocks.map((b) => {
        if (b.type !== 'turn_timer' || b.completedAt !== null) {
          return b;
        }
        if (b.pausedAt != null && b.resumedAt == null) {
          return options?.closePaused ? { ...b, completedAt: b.pausedAt } : b;
        }
        return { ...b, completedAt: Date.now() };
      }),
    };
  });
  return changed ? result : messages;
}

// ---------------------------------------------------------------------------
// Post-crash restore helpers
//
// When the renderer reloads after a crash, we want to avoid stamping an
// in-flight tab as `Completed` before the matching main-process session has a
// chance to settle. The helpers below encode a short grace window during
// which we keep the tab in `streaming` as long as the main-process session
// still shows recent nonterminal activity.
// ---------------------------------------------------------------------------

/**
 * Returns true if any message has an open `turn_timer` block (one whose
 * `completedAt` has not been filled in yet). Matches the same shape used by
 * `closeOpenTurnTimers`.
 */
export function hasOpenTurnTimer(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'turn_timer' && block.completedAt === null) {
        if (block.pausedAt != null && block.resumedAt == null) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

export function hasRecoverableStreamingState(messages: ChatMessage[]): boolean {
  return hasOpenTurnTimer(messages) || hasUnresolvedToolUse(messages);
}

export function hasPausedTurnTimer(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        block.pausedAt != null &&
        block.resumedAt == null,
    ),
  );
}

export function isRestoreTerminalSessionEvent(lastEventType?: string): boolean {
  return (
    lastEventType === 'result' ||
    lastEventType === 'error' ||
    lastEventType === 'codex:turn.completed' ||
    lastEventType === 'codex:turn.failed'
  );
}
