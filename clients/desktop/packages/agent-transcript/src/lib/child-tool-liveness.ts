import type { CodexAgentCallBlock, PersistedChatMessage } from '../types';

export type ChildToolLiveness =
  | { kind: 'no-live-session' }
  | { kind: 'unknown' }
  | {
      kind: 'known';
      liveParentToolUseIds: readonly string[];
      hasUncorrelatedLiveTask: boolean;
    };

export const CHILD_TOOL_LIVENESS_STAMP = 'canopy_child_tool_liveness';
export const CHILD_TOOLS_ENDED_EVENT_TYPE = 'canopy_child_tools_ended';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read and validate a stamp from a raw event record. */
export function readChildToolLivenessStamp(
  event: unknown,
): ChildToolLiveness | undefined {
  if (!isRecord(event)) return undefined;
  const stamp = event[CHILD_TOOL_LIVENESS_STAMP];
  if (!isRecord(stamp)) return undefined;
  if (stamp.kind === 'no-live-session' || stamp.kind === 'unknown') {
    return { kind: stamp.kind };
  }
  if (
    stamp.kind === 'known' &&
    Array.isArray(stamp.liveParentToolUseIds) &&
    stamp.liveParentToolUseIds.every((id: unknown) => typeof id === 'string') &&
    typeof stamp.hasUncorrelatedLiveTask === 'boolean'
  ) {
    return {
      kind: 'known',
      liveParentToolUseIds: stamp.liveParentToolUseIds,
      hasUncorrelatedLiveTask: stamp.hasUncorrelatedLiveTask,
    };
  }
  return undefined;
}

export interface ChildToolCloseContext {
  liveness: ChildToolLiveness;
  codexRootThreadId?: string;
  agentCallBlocksById: ReadonlyMap<string, CodexAgentCallBlock>;
}

export function indexCodexAgentCallBlocks(
  messages: readonly PersistedChatMessage[],
): ReadonlyMap<string, CodexAgentCallBlock> {
  const blocks = new Map<string, CodexAgentCallBlock>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'codex_agent_call')
        blocks.set(block.agentBlockId, block);
    }
  }
  return blocks;
}

const CODEX_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
  'cancelled',
]);

/** A parent ending does not imply that its background children have ended. */
export function shouldCloseToolUseMessage(
  message: Pick<
    PersistedChatMessage,
    'parentToolUseId' | 'parentBlockId' | 'codexThreadId'
  >,
  context: ChildToolCloseContext,
): boolean {
  if (context.liveness.kind === 'no-live-session') return true;
  if (
    message.parentBlockId !== undefined ||
    message.codexThreadId !== undefined
  ) {
    if (context.codexRootThreadId === undefined) return false;
    if (
      message.parentBlockId === undefined &&
      message.parentToolUseId === undefined &&
      message.codexThreadId === context.codexRootThreadId
    ) {
      return true;
    }
    const parent =
      message.parentBlockId === undefined
        ? undefined
        : context.agentCallBlocksById.get(message.parentBlockId);
    const receiver =
      message.codexThreadId === undefined
        ? undefined
        : parent?.agentsStates[message.codexThreadId];
    return (
      receiver !== undefined && CODEX_TERMINAL_STATUSES.has(receiver.status)
    );
  }
  if (message.parentToolUseId === undefined) return true;
  return (
    context.liveness.kind === 'known' &&
    !context.liveness.hasUncorrelatedLiveTask &&
    !context.liveness.liveParentToolUseIds.includes(message.parentToolUseId)
  );
}
