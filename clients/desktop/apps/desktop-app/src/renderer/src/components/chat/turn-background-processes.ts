import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import type {
  TurnBlock,
  TurnGroupOrMessage,
  TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';
import { groupBackgroundWorkByTurn } from '@canopy/ui-app/agent-activity';
import { useActivityStore } from '@/stores/activityStore';

const EMPTY_PROCESSES: readonly BackgroundProcess[] = [];

/**
 * Every tool-use identity a turn's assistant messages own, including the ones
 * folded into display-only variants (`agent` for Task/Agent, `workflow` for
 * Workflow) and the blocks nested inside a subagent. A background process is
 * keyed by the tool use that launched it, so this is what attributes a live
 * process to the turn that started it.
 */
function collectTurnToolUseIds(
  blocks: readonly TurnBlock[],
  into: Set<string>,
): void {
  for (const block of blocks) {
    if (
      block.type === 'tool_use' ||
      block.type === 'agent' ||
      block.type === 'workflow'
    ) {
      into.add(block.toolUseId);
    }
    if (block.type === 'agent' || block.type === 'codex_agent') {
      collectTurnToolUseIds(block.subBlocks, into);
    }
  }
}

export function turnToolUseIds(
  assistantMessages: readonly TurnMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of assistantMessages) {
    collectTurnToolUseIds(message.blocks, ids);
  }
  return ids;
}

export type TurnToolUseIdCache = WeakMap<
  readonly TurnMessage[],
  ReadonlySet<string>
>;

export function createTurnToolUseIdCache(): TurnToolUseIdCache {
  return new WeakMap();
}

/**
 * Group a chat's background processes under the turn that launched each one.
 *
 * The shared `groupBackgroundWorkByTurn` owns the grouping and the cheap
 * empty paths; this supplies the desktop turn model. It walks a turn's blocks
 * only when that turn's `assistantMessages` array is one it has not seen.
 * `TurnGroupCache` keeps that identity stable for completed turns, so a
 * streaming delta re-walks the streaming turn alone.
 */
export function groupBackgroundProcessesByTurn(
  turnGroups: readonly TurnGroupOrMessage[],
  processes: readonly BackgroundProcess[],
  chatId: string | undefined,
  cache: TurnToolUseIdCache,
): Readonly<Record<string, readonly BackgroundProcess[]>> {
  const chatProcesses =
    processes.length === 0 || chatId === undefined
      ? EMPTY_PROCESSES
      : processes.filter((process) => process.chatId === chatId);
  return groupBackgroundWorkByTurn(
    turnGroups,
    chatProcesses,
    (item) => {
      if (item.kind !== 'turn-group') return null;
      let toolUseIds = cache.get(item.assistantMessages);
      if (!toolUseIds) {
        toolUseIds = turnToolUseIds(item.assistantMessages);
        cache.set(item.assistantMessages, toolUseIds);
      }
      return { turnKey: item.userMessage.id, toolUseIds };
    },
    (process) => process.toolUseId,
  );
}

/**
 * One activity-store subscription for a whole transcript, keyed by turn.
 *
 * This is intentionally a list-level hook rather than a per-turn one: a
 * stress transcript mounts thousands of turn groups, and giving each its own
 * store subscription made every list re-render pay for N selector runs, which
 * showed up as typing latency in the `stress-transcript` benchmark. Callers
 * hand each turn its slice, falling back to a shared empty array so a turn
 * without background work keeps its memoized identity.
 */
export function useChatBackgroundProcessesByTurn(
  projectId: string | undefined,
  worktreeId: string | undefined,
  chatId: string | undefined,
  turnGroups: readonly TurnGroupOrMessage[],
): Readonly<Record<string, readonly BackgroundProcess[]>> {
  const cacheRef = useRef<TurnToolUseIdCache>(createTurnToolUseIdCache());
  const processes = useActivityStore(
    useShallow((state): readonly BackgroundProcess[] => {
      if (projectId === undefined || worktreeId === undefined) {
        return EMPTY_PROCESSES;
      }
      return state.bgProcesses[`${projectId}/${worktreeId}`] ?? EMPTY_PROCESSES;
    }),
  );
  return useMemo(
    () =>
      groupBackgroundProcessesByTurn(
        turnGroups,
        processes,
        chatId,
        cacheRef.current,
      ),
    [chatId, processes, turnGroups],
  );
}

export function turnBackgroundProcesses(
  byTurn: Readonly<Record<string, readonly BackgroundProcess[]>>,
  userMessageId: string,
): readonly BackgroundProcess[] {
  return byTurn[userMessageId] ?? EMPTY_PROCESSES;
}
