import {
  isAgentDelegationTranscript,
  type AgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
  PersistedChatBlock,
} from '../types';
import type { TranscriptReducerState } from './transcript-parser';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delegationBlockId(id: string, generation: number): string {
  return `delegated-agent-${id}${generation > 1 ? `-run-${generation}` : ''}`;
}

/**
 * A delegate's transcript items as child rows of its card, `agentBlockId`.
 * The same rows whether they come from a live snapshot, a parent transcript
 * written before delegate logs, or a delegate log.
 */
export function delegationChildMessages(
  agentBlockId: string,
  items: readonly AgentDelegationTranscriptItem[],
): PersistedChatMessage[] {
  return items.map((item) => {
    const id = `${agentBlockId}:${item.id}`;
    const blocks: PersistedChatBlock[] =
      item.type === 'tool'
        ? [
            {
              type: 'tool_use',
              toolUseId: id,
              toolName: item.toolName,
              input: item.input,
            },
            ...(item.output !== undefined
              ? [
                  {
                    type: 'tool_result' as const,
                    toolUseId: id,
                    toolName: item.toolName,
                    output: item.output,
                    isError: item.isError === true,
                  },
                ]
              : []),
          ]
        : [{ type: item.type, text: item.text }];
    return {
      id,
      role: item.type === 'text' && item.author ? 'user' : 'assistant',
      ...(item.type === 'text' && item.author
        ? { delegationAuthor: item.author }
        : {}),
      ...(item.type === 'text' && item.delivery
        ? { delegationDelivery: item.delivery }
        : {}),
      timestamp: item.occurredAt,
      parentBlockId: agentBlockId,
      delegationSequence: item.sequence,
      blocks,
    };
  });
}

/** Normalize once, at the shared parser boundary; neither provider owns these messages. */
export function delegationTranscriptMessages(
  value: AgentDelegationTranscript,
): PersistedChatMessage[] {
  const { snapshot, task, transcript } = value;
  const route = snapshot.routeSnapshot;
  const agentBlockId = delegationBlockId(
    value.delegationId,
    value.runGeneration,
  );
  const block: DelegatedAgentCallBlock = {
    ...snapshot,
    type: 'delegated_agent_call',
    agentBlockId,
    runGeneration: value.runGeneration,
    sequence: value.sequence,
    parentHarnessId: value.parentHarnessId,
    parentTurnId: value.parentTurnId,
    parentToolCallId: value.parentToolCallId,
    createdAt: value.createdAt,
    selectedModelId: route?.selectedModelId ?? snapshot.requestedModelId ?? '',
    runtimeModelId: route?.runtimeModelId ?? '',
    targetHarnessId: route?.harnessId ?? '',
    requestedThinkingLevel: route?.requestedThinkingLevel,
    effectiveThinkingLevel: route?.effectiveThinkingLevel,
    description: task.description,
    prompt: task.prompt,
    executionMode: task.executionMode,
    ...(value.transcriptStore
      ? { transcriptStore: value.transcriptStore }
      : {}),
  };
  const children = delegationChildMessages(agentBlockId, transcript);
  return [
    {
      id: agentBlockId,
      role: 'assistant',
      timestamp: value.createdAt,
      blocks: [block],
    },
    ...children,
  ];
}

export function applyDelegationTranscriptEvent(
  state: TranscriptReducerState,
  data: Record<string, unknown>,
): TranscriptReducerState {
  const value = data.delegation;
  if (!isAgentDelegationTranscript(value)) return state;
  const id = delegationBlockId(value.delegationId, value.runGeneration);
  const existingIndex = state.messages.findIndex((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'delegated_agent_call' && block.agentBlockId === id,
    ),
  );
  const prior =
    existingIndex >= 0
      ? state.messages[existingIndex].blocks.find(
          (block) =>
            block.type === 'delegated_agent_call' && block.agentBlockId === id,
        )
      : undefined;
  if (
    prior?.type === 'delegated_agent_call' &&
    (prior.runGeneration > value.runGeneration ||
      (prior.runGeneration === value.runGeneration &&
        prior.sequence >= value.sequence))
  )
    return state;
  const normalized = delegationTranscriptMessages(value);
  const updatedIds = new Set(normalized.map((message) => message.id));
  const retainedChildren =
    value.transcriptMode === 'patch'
      ? state.messages.filter(
          (message) =>
            message.parentBlockId === id && !updatedIds.has(message.id),
        )
      : [];
  normalized.push(...retainedChildren);
  const parent = normalized.shift();
  if (!parent) return state;
  normalized.sort(
    (left, right) =>
      (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0),
  );
  normalized.unshift(parent);
  const messages = state.messages.filter(
    (message) => message.id !== id && message.parentBlockId !== id,
  );
  // Recovery may arrive in a later root turn. Keep it beside its originating tool/turn.
  let insertAt = existingIndex;
  if (insertAt < 0) {
    const toolIndex = messages.findIndex((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'tool_use' &&
          block.toolUseId === value.parentToolCallId,
      ),
    );
    const turnIndex = messages.findIndex(
      (message) => message.id === value.parentTurnId,
    );
    // A user follow-up has no root turn or tool call of its own; its
    // delegate's earlier run card places it (below).
    const hasEarlierRun = messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'delegated_agent_call' &&
          block.delegationId === value.delegationId &&
          block.runGeneration < value.runGeneration,
      ),
    );
    if (toolIndex < 0 && turnIndex < 0 && !hasEarlierRun && messages.length > 0)
      return state;
    insertAt =
      toolIndex >= 0
        ? toolIndex + 1
        : turnIndex >= 0
          ? turnIndex + 1
          : messages.length;
  }
  if (existingIndex < 0) {
    // Generations may share their originating parent turn. Keep prior results
    // beside their child content, even when recovery arrives out of order.
    for (let index = 0; index < messages.length; index += 1) {
      const sibling = messages[index].blocks.find(
        (block) =>
          block.type === 'delegated_agent_call' &&
          block.delegationId === value.delegationId,
      );
      if (sibling?.type !== 'delegated_agent_call') continue;
      if (sibling.runGeneration > value.runGeneration) {
        insertAt = index;
        break;
      }
      if (sibling.runGeneration < value.runGeneration) {
        let end = index + 1;
        while (
          end < messages.length &&
          messages[end].parentBlockId === sibling.agentBlockId
        )
          end += 1;
        insertAt = Math.max(insertAt, end);
      }
    }
  }
  messages.splice(insertAt, 0, ...normalized);
  return { ...state, messages };
}

/** Persistence readers validate owned blocks through the same public contract. */
export function isDelegatedAgentCallBlock(
  value: unknown,
): value is DelegatedAgentCallBlock {
  if (!isRecord(value)) return false;
  const block = value;
  if (
    block.type !== 'delegated_agent_call' ||
    block.agentBlockId !==
      delegationBlockId(String(block.delegationId), Number(block.runGeneration))
  )
    return false;
  if (block.routeSnapshot !== undefined && !isRecord(block.routeSnapshot))
    return false;
  if (
    block.transcriptStore !== undefined &&
    block.transcriptStore !== 'chat-log-v1'
  )
    return false;
  const route = isRecord(block.routeSnapshot) ? block.routeSnapshot : undefined;
  return (
    block.selectedModelId ===
      (route?.selectedModelId ?? block.requestedModelId ?? '') &&
    block.runtimeModelId === (route?.runtimeModelId ?? '') &&
    block.targetHarnessId === (route?.harnessId ?? '') &&
    isAgentDelegationTranscript({
      delegationId: block.delegationId,
      runGeneration: block.runGeneration,
      sequence: block.sequence,
      parentHarnessId: block.parentHarnessId,
      parentTurnId: block.parentTurnId,
      parentToolCallId: block.parentToolCallId,
      createdAt: block.createdAt,
      task: {
        description: block.description,
        prompt: block.prompt,
        executionMode: block.executionMode,
      },
      snapshot: block,
      transcript: [],
    })
  );
}

/** Hide children only when the owning card is present; retain orphaned historical output. */
export function delegationRootMessages(
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  const parents = new Set(
    messages.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === 'delegated_agent_call' ? [block.agentBlockId] : [],
      ),
    ),
  );
  return messages.filter(
    (message) =>
      !message.hidden &&
      (!message.parentBlockId || !parents.has(message.parentBlockId)),
  );
}
