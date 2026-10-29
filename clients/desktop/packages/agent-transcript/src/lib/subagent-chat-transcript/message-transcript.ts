import type { DisplayBlock } from '../../message-display';
import type { PersistedChatMessage as ChatMessage } from '../../types';
import { mergeToolResults } from '../message-transforms';
import type { SubagentNode, SubagentTree } from '../subagent-tree';
import { claudeNativeDisplayAgentFor } from '../subagent-tree/native-inputs';
import { placeRunPrompt, subagentParentTitle } from './shared';
import type {
  SubagentChatTranscript,
  SubagentChatTranscriptItem,
  SubagentTranscriptRunSource,
} from './types';

const EMPTY_TRANSCRIPT: SubagentChatTranscript = {
  items: [],
  missingBeginning: false,
};

function parentBlockId(message: ChatMessage): string | undefined {
  return message.parentBlockId ?? message.parentToolUseId;
}

function ownedBlockIds(message: ChatMessage): readonly string[] {
  return message.blocks.flatMap((block) => {
    if (
      block.type === 'delegated_agent_call' ||
      block.type === 'codex_agent_call'
    ) {
      return [block.agentBlockId];
    }
    if (
      block.type === 'tool_use' &&
      (block.toolName === 'Task' || block.toolName === 'Agent')
    ) {
      return [block.toolUseId];
    }
    return [];
  });
}

/** Selects a run's messages and all nested transcript rows it owns. */
function messagesForRun(
  messages: readonly ChatMessage[],
  agentBlockId: string,
): ChatMessage[] {
  const ownerIds = new Set([agentBlockId]);
  const included = new Set<string>();
  const selected: ChatMessage[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    for (const message of messages) {
      if (included.has(message.id)) continue;
      const parentId = parentBlockId(message);
      if (parentId === undefined || !ownerIds.has(parentId)) continue;
      included.add(message.id);
      selected.push(message);
      ownedBlockIds(message).forEach((id) => ownerIds.add(id));
      changed = true;
    }
  }

  return selected;
}

/** Promotes the selected run's own rows for merging while retaining nested links. */
function promoteRunMessages(
  messages: readonly ChatMessage[],
  agentBlockId: string,
): ChatMessage[] {
  return messages.map((message) => {
    if (parentBlockId(message) !== agentBlockId) return message;
    const topLevel = { ...message };
    delete topLevel.parentBlockId;
    delete topLevel.parentToolUseId;
    return topLevel;
  });
}

function messageText(message: ChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

function transcriptMessageItems(
  messages: readonly ChatMessage[],
  agentBlockId: string,
  parentTitle: string,
): {
  readonly items: readonly SubagentChatTranscriptItem[];
  readonly missingBeginning: boolean;
} {
  const selected = messagesForRun(messages, agentBlockId);
  if (selected.length === 0) return { items: [], missingBeginning: false };

  const ordered = [...selected].sort(
    (left, right) =>
      (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0) ||
      left.timestamp - right.timestamp,
  );
  const firstSequence = ordered[0]?.delegationSequence;
  // Delegation transcript sequence numbers begin at one. Only a larger first
  // sequence proves that the loaded window omitted the beginning.
  const missingBeginning = firstSequence !== undefined && firstSequence > 1;
  const rawById = new Map(ordered.map((message) => [message.id, message]));
  const displayMessages = mergeToolResults(
    promoteRunMessages(ordered, agentBlockId),
  );
  const items: SubagentChatTranscriptItem[] = [];

  for (const displayMessage of displayMessages) {
    const source = rawById.get(displayMessage.id);
    if (!source) continue;
    const text = messageText(source);
    if (source.delegationAuthor?.kind === 'agent') {
      items.push({
        kind: 'follow_up',
        key: displayMessage.id,
        sender: source.delegationAuthor.description ?? parentTitle,
        text,
      });
      continue;
    }
    if (source.delegationAuthor?.kind === 'user') {
      items.push({
        kind: 'user',
        key: displayMessage.id,
        text,
        steering: source.delegationDelivery === 'steer',
        ...(source.agentSent !== undefined
          ? { agentSent: source.agentSent }
          : {}),
      });
      continue;
    }
    items.push({
      kind: 'blocks',
      key: displayMessage.id,
      displayMessage,
      blocks: displayMessage.blocks,
    });
  }
  return { items, missingBeginning };
}

function managedPromptForRun(
  rootMessages: readonly ChatMessage[],
  node: SubagentNode,
  run: SubagentTranscriptRunSource,
): string {
  if (run.prompt !== undefined) return run.prompt;
  for (const message of rootMessages) {
    for (const block of message.blocks) {
      if (
        block.type === 'delegated_agent_call' &&
        block.delegationId === node.id &&
        block.runGeneration === run.runGeneration
      ) {
        return block.prompt;
      }
    }
  }
  const latestRun = node.runs.reduce<SubagentNode['runs'][number] | undefined>(
    (latest, candidate) =>
      latest === undefined || candidate.runGeneration > latest.runGeneration
        ? candidate
        : latest,
    undefined,
  );
  return latestRun?.runGeneration === run.runGeneration
    ? (node.prompt ?? '')
    : '';
}

function managedAgentBlockId(
  node: SubagentNode,
  run: SubagentTranscriptRunSource,
): string {
  return (
    run.agentBlockId ??
    `delegated-agent-${node.id}${run.runGeneration > 1 ? `-run-${run.runGeneration}` : ''}`
  );
}

function mergeMessageSources(
  pagedMessages: readonly ChatMessage[],
  rootMessages: readonly ChatMessage[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const indexById = new Map<string, number>();
  for (const message of pagedMessages) {
    indexById.set(message.id, messages.length);
    messages.push(message);
  }
  for (const message of rootMessages) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, messages.length);
      messages.push(message);
    } else {
      messages[existingIndex] = message;
    }
  }
  return messages;
}

function addCodexDisplayBlocks(
  blocks: readonly DisplayBlock[],
  node: SubagentNode,
  nativePrompt: { value: string | undefined },
  foundNative: { value: boolean },
  selectedBlocks: DisplayBlock[],
): void {
  for (const block of blocks) {
    if (
      node.kind === 'codex-native' &&
      block.type === 'codex_agent' &&
      (block.senderThreadId === node.id ||
        block.receiverThreadIds.includes(node.id) ||
        block.callId === node.id ||
        node.runs.some((run) => run.agentBlockId === block.agentBlockId))
    ) {
      foundNative.value = true;
      nativePrompt.value = block.prompt;
      selectedBlocks.push(...block.subBlocks);
      continue;
    }
    if ('subBlocks' in block) {
      addCodexDisplayBlocks(
        block.subBlocks,
        node,
        nativePrompt,
        foundNative,
        selectedBlocks,
      );
    }
  }
}

/** Builds a managed or provider-native subagent transcript from root-chat data. */
export function buildSubagentChatTranscript(input: {
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  readonly rootMessages: readonly ChatMessage[];
  readonly runs?: readonly SubagentTranscriptRunSource[];
}): SubagentChatTranscript {
  const { tree, node, rootMessages } = input;
  const parentTitle = subagentParentTitle(tree, node);
  if (node.kind === 'managed') {
    const runSources: readonly SubagentTranscriptRunSource[] =
      input.runs ??
      node.runs.map((run) => ({
        runGeneration: run.runGeneration,
        ...(run.agentBlockId !== undefined
          ? { agentBlockId: run.agentBlockId }
          : {}),
      }));
    const runs = [...runSources].sort(
      (left, right) => left.runGeneration - right.runGeneration,
    );
    if (runs.length === 0) return EMPTY_TRANSCRIPT;
    const items: SubagentChatTranscriptItem[] = [];
    let missingBeginning = false;
    runs.forEach((run, index) => {
      if (index > 0) {
        items.push({
          kind: 'divider',
          key: `run-${run.runGeneration}`,
          runGeneration: run.runGeneration,
        });
      }
      const prompt = managedPromptForRun(rootMessages, node, run);
      const agentBlockId = managedAgentBlockId(node, run);
      const runRootMessages = run.replacesRootRows
        ? rootMessages.filter(
            (message) => parentBlockId(message) !== agentBlockId,
          )
        : rootMessages;
      const transcript = transcriptMessageItems(
        mergeMessageSources(run.pagedMessages ?? [], runRootMessages),
        agentBlockId,
        parentTitle,
      );
      missingBeginning ||= transcript.missingBeginning;
      items.push(
        ...placeRunPrompt({
          key: `task-${run.runGeneration}`,
          prompt,
          sender: parentTitle,
          items: transcript.items,
        }),
      );
    });
    return { items, missingBeginning };
  }

  if (node.kind === 'claude-native') {
    return claudeNativeTranscript(rootMessages, node, parentTitle);
  }
  const codexThread = codexThreadTranscript(rootMessages, node, parentTitle);
  if (codexThread) return codexThread;

  const displayMessages = mergeToolResults([...rootMessages]);
  const nativePrompt: { value: string | undefined } = { value: undefined };
  const foundNative: { value: boolean } = { value: false };
  const nativeBlocks: DisplayBlock[] = [];
  let originMessageId = '';
  for (const displayMessage of displayMessages) {
    const foundBefore = foundNative.value;
    addCodexDisplayBlocks(
      displayMessage.blocks,
      node,
      nativePrompt,
      foundNative,
      nativeBlocks,
    );
    if (!foundBefore && foundNative.value) originMessageId = displayMessage.id;
  }
  if (!foundNative.value) return EMPTY_TRANSCRIPT;

  const prompt = nativePrompt.value ?? node.prompt ?? '';
  const items: SubagentChatTranscriptItem[] = [];
  if (prompt.length > 0) {
    items.push({
      kind: 'task',
      key: `task-${node.id}`,
      sender: parentTitle,
      text: prompt,
    });
  }
  items.push({
    kind: 'blocks',
    key: `native-${node.id}`,
    displayMessage: {
      id: originMessageId,
      role: 'assistant',
      blocks: nativeBlocks,
      timestamp: 0,
    },
    blocks: nativeBlocks,
  });
  return { items, missingBeginning: false };
}

function findClaudeAgentBlock(
  blocks: readonly DisplayBlock[],
  toolUseId: string,
): Extract<DisplayBlock, { type: 'agent' }> | undefined {
  for (const block of blocks) {
    if (block.type === 'agent' && block.toolUseId === toolUseId) return block;
    if ('subBlocks' in block) {
      const nested = findClaudeAgentBlock(block.subBlocks, toolUseId);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * A Claude Task's transcript: its streamed rows when the display transform
 * attached them, else the rows it owns through `parentToolUseId` (a nested
 * Task stays a raw tool call), else its final answer.
 */
function claudeNativeTranscript(
  rootMessages: readonly ChatMessage[],
  node: SubagentNode,
  parentTitle: string,
): SubagentChatTranscript {
  let originMessageId = '';
  let agent: Extract<DisplayBlock, { type: 'agent' }> | null | undefined;
  for (const displayMessage of mergeToolResults([...rootMessages])) {
    agent = findClaudeAgentBlock(displayMessage.blocks, node.id);
    if (agent) {
      originMessageId = displayMessage.id;
      break;
    }
  }
  agent ??= claudeNativeDisplayAgentFor(rootMessages, node.id);
  if (!agent) return EMPTY_TRANSCRIPT;

  const items: SubagentChatTranscriptItem[] = [];
  const prompt = agent.prompt || node.prompt || '';
  if (prompt.length > 0) {
    items.push({
      kind: 'task',
      key: `task-${node.id}`,
      sender: parentTitle,
      text: prompt,
    });
  }
  const nativeBlock = (blocks: DisplayBlock[]): SubagentChatTranscriptItem => ({
    kind: 'blocks',
    key: `native-${node.id}`,
    displayMessage: {
      id: originMessageId,
      role: 'assistant',
      blocks,
      timestamp: 0,
    },
    blocks,
  });
  if (agent.subBlocks.length > 0) {
    items.push(nativeBlock(agent.subBlocks));
    return { items, missingBeginning: false };
  }
  const owned = transcriptMessageItems(rootMessages, node.id, parentTitle);
  if (owned.items.length > 0) {
    items.push(...owned.items);
    return { items, missingBeginning: owned.missingBeginning };
  }
  const answer = (agent.taskOutputResult ?? agent.result)?.output.trim();
  if (answer) items.push(nativeBlock([{ type: 'text', text: answer }]));
  return { items, missingBeginning: false };
}

function codexSpawnPrompt(
  rootMessages: readonly ChatMessage[],
  threadId: string,
): string | undefined {
  let fallback: string | undefined;
  for (const message of rootMessages) {
    for (const block of message.blocks) {
      if (
        block.type !== 'codex_agent_call' ||
        !block.receiverThreadIds.includes(threadId)
      ) {
        continue;
      }
      if (block.tool === 'spawnAgent') return block.prompt;
      fallback ??= block.prompt;
    }
  }
  return fallback;
}

/**
 * A Codex receiver's transcript from its own thread's rows and the rows
 * nested under them. Receivers that share one call's agent block are told
 * apart by `codexThreadId`, which the display merge does not keep.
 */
function codexThreadTranscript(
  rootMessages: readonly ChatMessage[],
  node: SubagentNode,
  parentTitle: string,
): SubagentChatTranscript | null {
  // Rows are selected by identity: Codex item ids are unique only per thread,
  // so sibling receivers persist rows with the same message id.
  const ownMessages = rootMessages.filter(
    (message) => message.codexThreadId === node.id,
  );
  if (ownMessages.length === 0) return null;
  const own = new Set(ownMessages);
  const included = new Set(ownMessages);
  const ownerIds = new Set(ownMessages.flatMap(ownedBlockIds));
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of rootMessages) {
      if (included.has(message)) continue;
      const parentId = parentBlockId(message);
      if (parentId === undefined || !ownerIds.has(parentId)) continue;
      included.add(message);
      ownedBlockIds(message).forEach((id) => ownerIds.add(id));
      changed = true;
    }
  }

  const promoted = rootMessages
    .filter((message) => included.has(message))
    .map((message) => {
      if (!own.has(message)) return message;
      const topLevel = { ...message };
      delete topLevel.parentBlockId;
      delete topLevel.parentToolUseId;
      return topLevel;
    });
  const items: SubagentChatTranscriptItem[] = [];
  const prompt = codexSpawnPrompt(rootMessages, node.id) ?? node.prompt ?? '';
  if (prompt.length > 0) {
    items.push({
      kind: 'task',
      key: `task-${node.id}`,
      sender: parentTitle,
      text: prompt,
    });
  }
  for (const displayMessage of mergeToolResults(promoted)) {
    items.push({
      kind: 'blocks',
      key: displayMessage.id,
      displayMessage,
      blocks: displayMessage.blocks,
    });
  }
  return { items, missingBeginning: false };
}
