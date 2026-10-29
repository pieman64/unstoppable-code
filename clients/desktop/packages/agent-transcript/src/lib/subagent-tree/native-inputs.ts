/**
 * Native subagent tree inputs from one persisted root transcript: Claude
 * Task/Agent calls, Codex collaboration calls and managed blocks, with each
 * block's parent resolved from its message's parent link. Shared by every
 * host that holds persisted messages (the desktop renderer today).
 * Imported by subpath (`@canopy/agent-transcript/lib/subagent-tree/native-inputs`),
 * not from the package root, because it pulls in `mergeToolResults`.
 */
import type { BackgroundTaskStatus } from '@canopy/protocol/background-tasks';
import type { DisplayBlock, ToolResult } from '../../message-display';
import type { PersistedChatBlock, PersistedChatMessage } from '../../types';
import { isClaudeAgentRunning } from '../agent-block-state';
import { mergeToolResults } from '../message-transforms';
import {
  managedSubagentInputFromBlock,
  type ClaudeNativeSubagentInput,
  type CodexNativeCallInput,
  type ManagedSubagentInput,
} from './index';

export interface LoadedSubagentInputs {
  readonly managed: readonly ManagedSubagentInput[];
  readonly claudeNative: readonly ClaudeNativeSubagentInput[];
  readonly codexNative: readonly CodexNativeCallInput[];
}

export interface LoadedSubagentSummary {
  readonly hasNativeAgentBlocks: boolean;
  readonly total: number;
  readonly live: number;
  readonly lastActivityAt?: number;
}

interface ParentBlockIdentity {
  readonly kind: 'managed' | 'claude-native' | 'codex-native';
  readonly id: string;
  readonly receiverThreadIds?: readonly string[];
}

interface ParentIdentity {
  readonly kind: ParentBlockIdentity['kind'];
  readonly id: string;
}

type ClaudeDisplayAgent = Extract<DisplayBlock, { type: 'agent' }>;

const EMPTY_LOADED_SUMMARY: LoadedSubagentSummary = {
  hasNativeAgentBlocks: false,
  total: 0,
  live: 0,
};

/** The status-independent part of a root chat's native-agent summary. */
interface LoadedSubagentScan {
  readonly total: number;
  readonly claudeAgents: readonly {
    readonly toolUseId: string;
    readonly runInBackground: boolean;
    readonly result?: ToolResult;
    readonly taskOutputResult?: ToolResult;
  }[];
  readonly codexLive: number;
  readonly lastActivityAt?: number;
}

const loadedScanCache = new WeakMap<
  readonly PersistedChatMessage[],
  LoadedSubagentScan
>();

function addDisplayAgents(
  blocks: readonly DisplayBlock[],
  byToolUseId: Map<string, Extract<DisplayBlock, { type: 'agent' }>>,
): void {
  for (const block of blocks) {
    if (block.type === 'agent') {
      byToolUseId.set(block.toolUseId, block);
      addDisplayAgents(block.subBlocks, byToolUseId);
      continue;
    }
    if (block.type === 'delegated_agent_call' || block.type === 'codex_agent') {
      addDisplayAgents(block.subBlocks, byToolUseId);
    }
  }
}

function parentForMessage(
  message: PersistedChatMessage,
  identities: ReadonlyMap<string, ParentBlockIdentity>,
): ParentIdentity | null {
  const parentKey = message.parentBlockId ?? message.parentToolUseId;
  if (!parentKey) return null;
  const parent = identities.get(parentKey);
  if (!parent) return null;
  if (parent.kind !== 'codex-native') {
    return { kind: parent.kind, id: parent.id };
  }

  const threadId =
    message.codexThreadId ??
    (parent.receiverThreadIds?.length === 1
      ? parent.receiverThreadIds[0]
      : undefined);
  return threadId ? { kind: parent.kind, id: threadId } : null;
}

function isTransientCodexSpawnStart(block: {
  readonly status: string;
  readonly receiverThreadIds: readonly string[];
  readonly agentsStates: Readonly<Record<string, unknown>>;
}): boolean {
  return (
    block.status === 'inProgress' &&
    block.receiverThreadIds.length === 0 &&
    Object.keys(block.agentsStates).length === 0
  );
}

function codexInput(
  block: Extract<PersistedChatBlock, { type: 'codex_agent_call' }>,
  message: PersistedChatMessage,
  parent: ParentIdentity | null,
): CodexNativeCallInput {
  return {
    agentBlockId: block.agentBlockId,
    callId: block.callId,
    tool: block.tool,
    status: block.status,
    senderThreadId:
      parent !== null && parent.kind !== 'codex-native'
        ? parent.id
        : block.senderThreadId,
    receiverThreadIds: block.receiverThreadIds,
    prompt: block.prompt,
    ...(block.model !== undefined ? { model: block.model } : {}),
    ...(block.reasoningEffort !== undefined
      ? { reasoningEffort: block.reasoningEffort }
      : {}),
    agentsStates: block.agentsStates,
    ...(block.receiverAgents !== undefined
      ? { receiverAgents: block.receiverAgents }
      : {}),
    occurredAt: message.timestamp,
  };
}

function resultMapForMessages(
  messages: readonly PersistedChatMessage[],
): ReadonlyMap<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_result') continue;
      results.set(block.toolUseId, {
        output: block.output,
        isError: block.isError,
      });
    }
  }
  return results;
}

function taskOutputResultsForMessages(
  messages: readonly PersistedChatMessage[],
  results: ReadonlyMap<string, ToolResult>,
): ReadonlyMap<string, ToolResult> {
  const taskOutputResults = new Map<string, ToolResult>();
  taskOutputCallsForMessages(messages, results).forEach(
    (taskOutputToolUseId: string, agentToolUseId: string): void => {
      const result = results.get(taskOutputToolUseId);
      if (result) taskOutputResults.set(agentToolUseId, result);
    },
  );
  return taskOutputResults;
}

/** The answered TaskOutput call that read each Claude agent, by agent tool-use id. */
function taskOutputCallsForMessages(
  messages: readonly PersistedChatMessage[],
  results: ReadonlyMap<string, ToolResult>,
): ReadonlyMap<string, string> {
  const taskIdToToolUseId = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (
        block.type !== 'tool_use' ||
        (block.toolName !== 'Task' && block.toolName !== 'Agent')
      ) {
        continue;
      }
      taskIdToToolUseId.set(block.toolUseId, block.toolUseId);
      const result = results.get(block.toolUseId);
      const launchedAgentId = result?.output.match(
        /agentId:\s*([a-f0-9-]+)/i,
      )?.[1];
      if (launchedAgentId) {
        taskIdToToolUseId.set(launchedAgentId, block.toolUseId);
      }
    }
  }

  const taskOutputCalls = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || block.toolName !== 'TaskOutput')
        continue;
      const parsed = parseObject(block.input);
      const taskId = parsed ? stringProperty(parsed, 'task_id') : undefined;
      if (!taskId) continue;
      const agentToolUseId = taskIdToToolUseId.get(taskId);
      if (agentToolUseId && results.has(block.toolUseId)) {
        taskOutputCalls.set(agentToolUseId, block.toolUseId);
      }
    }
  }
  return taskOutputCalls;
}

function rawClaudeDisplayAgent(
  block: Extract<PersistedChatBlock, { type: 'tool_use' }>,
  result: ToolResult | undefined,
  taskOutputResult: ToolResult | undefined,
): ClaudeDisplayAgent | null {
  const parsed = parseObject(block.input);
  if (!parsed) return null;
  return {
    type: 'agent',
    toolUseId: block.toolUseId,
    subagentType: stringProperty(parsed, 'subagent_type') ?? 'Agent',
    description: stringProperty(parsed, 'description') ?? '',
    prompt: stringProperty(parsed, 'prompt') ?? '',
    runInBackground: booleanProperty(parsed, 'run_in_background'),
    ...(result !== undefined ? { result } : {}),
    ...(taskOutputResult !== undefined ? { taskOutputResult } : {}),
    subBlocks: [],
  };
}

/**
 * One Claude Task call projected like a display `agent` block, with its result
 * and any later TaskOutput result. Nested Tasks stay raw `tool_use` blocks in
 * the display transform, so the tree and transcript both read them here.
 */
export function claudeNativeDisplayAgentFor(
  messages: readonly PersistedChatMessage[],
  toolUseId: string,
): ClaudeDisplayAgent | null {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (
        block.type !== 'tool_use' ||
        (block.toolName !== 'Task' && block.toolName !== 'Agent') ||
        block.toolUseId !== toolUseId
      ) {
        continue;
      }
      const results = resultMapForMessages(messages);
      return rawClaudeDisplayAgent(
        block,
        results.get(toolUseId),
        taskOutputResultsForMessages(messages, results).get(toolUseId),
      );
    }
  }
  return null;
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

/** Collects tree inputs from one loaded root transcript without retaining its messages. */
export function collectLoadedSubagentInputs(
  messages: readonly PersistedChatMessage[],
  options: {
    readonly backgroundStatusFor?: (
      toolUseId: string,
    ) => BackgroundTaskStatus | undefined;
    /**
     * When the host saw a background agent settle, in epoch ms. A launch
     * receipt is not a settle time; without this the agent has none until a
     * TaskOutput call reads its result.
     */
    readonly backgroundSettledAtFor?: (toolUseId: string) => number | undefined;
  } = {},
): LoadedSubagentInputs {
  const managedBlocks: {
    readonly block: Extract<
      PersistedChatBlock,
      { type: 'delegated_agent_call' }
    >;
    readonly message: PersistedChatMessage;
  }[] = [];
  const codexNative: CodexNativeCallInput[] = [];
  const identities = new Map<string, ParentBlockIdentity>();
  const toolUseTimes = new Map<string, number>();
  const resultTimes = new Map<string, number>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'delegated_agent_call') {
        managedBlocks.push({ block, message });
        identities.set(block.agentBlockId, {
          kind: 'managed',
          id: block.delegationId,
        });
      } else if (block.type === 'codex_agent_call') {
        identities.set(block.agentBlockId, {
          kind: 'codex-native',
          id: block.agentBlockId,
          receiverThreadIds: block.receiverThreadIds,
        });
      } else if (
        block.type === 'tool_use' &&
        (block.toolName === 'Task' || block.toolName === 'Agent')
      ) {
        identities.set(block.toolUseId, {
          kind: 'claude-native',
          id: block.toolUseId,
        });
        toolUseTimes.set(block.toolUseId, message.timestamp);
      } else if (block.type === 'tool_result') {
        resultTimes.set(block.toolUseId, message.timestamp);
      }
    }
  }

  const managed = managedBlocks.map(({ block, message }) => {
    const input = managedSubagentInputFromBlock(block);
    const parent = parentForMessage(message, identities);
    return parent
      ? {
          ...input,
          snapshot: { ...input.snapshot, parentDelegationId: parent.id },
        }
      : input;
  });

  // Parent identity is resolved after the complete transcript index exists so
  // a nested block may precede its parent's block in persisted message order.
  codexNative.length = 0;
  for (const message of messages) {
    const parent = parentForMessage(message, identities);
    for (const block of message.blocks) {
      if (
        block.type === 'codex_agent_call' &&
        !isTransientCodexSpawnStart(block)
      ) {
        codexNative.push(codexInput(block, message, parent));
      }
    }
  }

  const displayAgentById = new Map<string, ClaudeDisplayAgent>();
  for (const message of mergeToolResults([...messages])) {
    addDisplayAgents(message.blocks, displayAgentById);
  }

  const toolResults = resultMapForMessages(messages);
  const taskOutputResults = taskOutputResultsForMessages(messages, toolResults);
  const taskOutputCalls = taskOutputCallsForMessages(messages, toolResults);
  const claudeNative: ClaudeNativeSubagentInput[] = [];
  for (const message of messages) {
    const parent = parentForMessage(message, identities);
    for (const block of message.blocks) {
      if (
        block.type !== 'tool_use' ||
        (block.toolName !== 'Task' && block.toolName !== 'Agent')
      ) {
        continue;
      }
      // The display transform wraps root-flow Tasks in `agent` blocks. A Task
      // inside another provider's subagent group remains a raw tool_use, so
      // provide the same small display projection for that nested case.
      const display =
        displayAgentById.get(block.toolUseId) ??
        rawClaudeDisplayAgent(
          block,
          toolResults.get(block.toolUseId),
          taskOutputResults.get(block.toolUseId),
        );
      if (!display) continue;
      const running = isClaudeAgentRunning(
        display.runInBackground,
        display.result,
        display.taskOutputResult,
        options.backgroundStatusFor?.(block.toolUseId),
      );
      const taskOutputResult =
        display.taskOutputResult ?? taskOutputResults.get(block.toolUseId);
      const result = taskOutputResult ?? display.result;
      const state = running
        ? 'running'
        : result?.isError === true
          ? 'failed'
          : 'completed';
      const taskOutputCall = taskOutputCalls.get(block.toolUseId);
      const launchedOnly =
        taskOutputResult === undefined &&
        isClaudeAgentRunning(display.runInBackground, display.result);
      const settledAt =
        taskOutputCall !== undefined
          ? resultTimes.get(taskOutputCall)
          : launchedOnly
            ? options.backgroundSettledAtFor?.(block.toolUseId)
            : resultTimes.get(block.toolUseId);
      const startedAt = toolUseTimes.get(block.toolUseId);
      const errorMessage =
        state === 'failed' ? result?.output.trim() : undefined;
      claudeNative.push({
        toolUseId: block.toolUseId,
        parentId: parent?.id ?? null,
        subagentType: display.subagentType,
        description: display.description,
        prompt: display.prompt,
        state,
        ...(errorMessage ? { errorMessage } : {}),
        runInBackground: display.runInBackground,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(!running && settledAt !== undefined ? { settledAt } : {}),
      });
    }
  }

  return { managed, claudeNative, codexNative };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function booleanProperty(value: Record<string, unknown>, key: string): boolean {
  return value[key] === true;
}

function codexStatusIsLive(status: string | undefined): boolean {
  return (
    status === undefined ||
    status === 'pendingInit' ||
    status === 'running' ||
    status === 'inProgress'
  );
}

/**
 * Cheap native-agent scan for the root picker; does not run display
 * transforms. A background Claude task counts as live while its process is
 * queued or running, so pass its current background status when known.
 */
export function loadedSubagentSummary(
  messages: readonly PersistedChatMessage[],
  backgroundStatusFor?: (toolUseId: string) => BackgroundTaskStatus | undefined,
): LoadedSubagentSummary {
  const scan = loadedSubagentScan(messages);
  if (scan.total === 0) return EMPTY_LOADED_SUMMARY;
  let live = scan.codexLive;
  for (const agent of scan.claudeAgents) {
    if (
      isClaudeAgentRunning(
        agent.runInBackground,
        agent.result,
        agent.taskOutputResult,
        backgroundStatusFor?.(agent.toolUseId),
      )
    )
      live += 1;
  }
  return {
    hasNativeAgentBlocks: true,
    total: scan.total,
    live,
    ...(scan.lastActivityAt !== undefined
      ? { lastActivityAt: scan.lastActivityAt }
      : {}),
  };
}

function loadedSubagentScan(
  messages: readonly PersistedChatMessage[],
): LoadedSubagentScan {
  const cached = loadedScanCache.get(messages);
  if (cached) return cached;

  const claudeIds = new Set<string>();
  const codexIds = new Set<string>();
  const claudeCalls = new Map<string, { readonly runInBackground: boolean }>();
  const results = resultMapForMessages(messages);
  const taskOutputResults = taskOutputResultsForMessages(messages, results);
  const codexStatuses = new Map<string, string | undefined>();
  const codexTimes = new Map<string, number>();
  let latestNativeTimestamp: number | undefined;

  for (const message of messages) {
    for (const block of message.blocks) {
      if (
        block.type === 'tool_use' &&
        (block.toolName === 'Task' || block.toolName === 'Agent')
      ) {
        claudeIds.add(block.toolUseId);
        const parsed = parseObject(block.input);
        claudeCalls.set(block.toolUseId, {
          runInBackground: parsed
            ? booleanProperty(parsed, 'run_in_background')
            : false,
        });
        latestNativeTimestamp = Math.max(
          latestNativeTimestamp ?? message.timestamp,
          message.timestamp,
        );
      } else if (
        block.type === 'codex_agent_call' &&
        !isTransientCodexSpawnStart(block)
      ) {
        const receiverIds =
          block.receiverThreadIds.length > 0
            ? block.receiverThreadIds
            : [block.agentBlockId];
        for (const receiverId of receiverIds) {
          codexIds.add(receiverId);
          const state = block.agentsStates[receiverId];
          const previousTime = codexTimes.get(receiverId);
          if (previousTime === undefined || message.timestamp >= previousTime) {
            codexTimes.set(receiverId, message.timestamp);
            if (state) {
              codexStatuses.set(receiverId, state.status);
            } else if (!codexStatuses.has(receiverId)) {
              codexStatuses.set(receiverId, block.status);
            }
          }
        }
        latestNativeTimestamp = Math.max(
          latestNativeTimestamp ?? message.timestamp,
          message.timestamp,
        );
      }
    }
  }

  const claudeAgents: LoadedSubagentScan['claudeAgents'][number][] = [];
  claudeIds.forEach((toolUseId: string): void => {
    const call = claudeCalls.get(toolUseId);
    if (!call) return;
    const result = results.get(toolUseId);
    const taskOutputResult = taskOutputResults.get(toolUseId);
    claudeAgents.push({
      toolUseId,
      runInBackground: call.runInBackground,
      ...(result ? { result } : {}),
      ...(taskOutputResult ? { taskOutputResult } : {}),
    });
  });
  let codexLive = 0;
  codexIds.forEach((codexId: string): void => {
    if (codexStatusIsLive(codexStatuses.get(codexId))) codexLive += 1;
  });

  const scan: LoadedSubagentScan = {
    total: claudeIds.size + codexIds.size,
    claudeAgents,
    codexLive,
    ...(latestNativeTimestamp !== undefined
      ? { lastActivityAt: latestNativeTimestamp }
      : {}),
  };
  loadedScanCache.set(messages, scan);
  return scan;
}
