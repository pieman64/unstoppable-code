import {
  AGENT_STEP_LIMIT,
  delegateAgentMeta,
  delegateAgentStatus,
  type BackgroundTrayAgent,
  type BackgroundTrayAgentStep,
} from '@canopy/ui-app';
import { SUBAGENT_UNTITLED_LABEL } from '@canopy/ui-shared';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import type { DisplayBlock } from './types';

const NO_DELEGATION_IDS: ReadonlySet<string> = new Set();

/** An agent block's tool calls and nested agents, newest last. */
export function agentSteps(
  subBlocks: readonly DisplayBlock[],
): BackgroundTrayAgentStep[] {
  return subBlocks
    .flatMap((block): BackgroundTrayAgentStep[] => {
      if (block.type === 'tool_use')
        return [
          { id: block.toolUseId, toolName: block.toolName, input: block.input },
        ];
      if (block.type === 'agent')
        return [
          {
            id: block.toolUseId,
            toolName: 'Agent',
            input: JSON.stringify({
              subagent_type: block.subagentType,
              description: block.description,
              prompt: block.prompt,
            }),
          },
        ];
      return [];
    })
    .slice(-AGENT_STEP_LIMIT);
}

/**
 * The chat's live background subagents (`selectActiveAgentBlocks`) as the
 * background drawer lists them. A Claude background agent carries its
 * background task, matched by tool use id: the drawer lists it once, as the
 * agent, and stops it through that task. Delegates stop through the host;
 * Codex native children have no Stop (turn-state D10).
 */
export function backgroundTrayAgents(
  blocks: readonly DisplayBlock[],
  processes: readonly BackgroundProcess[],
  chatId: string,
  withLiveDescendants: ReadonlySet<string> = NO_DELEGATION_IDS,
): BackgroundTrayAgent[] {
  return blocks.flatMap((block): BackgroundTrayAgent[] => {
    switch (block.type) {
      case 'agent': {
        const process = processes.find(
          (item) =>
            item.chatId === chatId && item.toolUseId === block.toolUseId,
        );
        const title =
          block.description || block.subagentType || SUBAGENT_UNTITLED_LABEL;
        return [
          {
            id: `claude:${block.toolUseId}`,
            kind: 'claude',
            title,
            status: 'running',
            activity: process?.lastDescription ?? null,
            startedAt: process?.startedAt ?? null,
            steps: agentSteps(block.subBlocks),
            prompt: block.prompt || null,
            meta: `Claude · ${block.subagentType}`,
            taskId: process?.id ?? null,
            canStop: false,
            target: { kind: 'claude-native', id: block.toolUseId, title },
          },
        ];
      }
      case 'codex_agent': {
        const title =
          block.description || block.displayName || SUBAGENT_UNTITLED_LABEL;
        return [
          {
            id: `codex:${block.agentBlockId}`,
            kind: 'codex',
            title,
            status: 'running',
            activity: null,
            startedAt: null,
            steps: agentSteps(block.subBlocks),
            prompt: block.prompt || null,
            meta: ['Codex', block.model, block.reasoningEffort]
              .filter((part) => part !== undefined && part !== '')
              .join(' · '),
            taskId: null,
            canStop: false,
            target: {
              kind: 'codex-native',
              id: block.receiverThreadIds[0] ?? block.agentBlockId,
              title,
            },
          },
        ];
      }
      case 'delegated_agent_call': {
        const title = block.description || SUBAGENT_UNTITLED_LABEL;
        return [
          {
            id: `managed:${block.delegationId}`,
            kind: 'delegate',
            title,
            status: delegateAgentStatus(block),
            activity: null,
            startedAt: block.createdAt,
            steps: agentSteps(block.subBlocks),
            prompt: block.prompt || null,
            meta: delegateAgentMeta(block),
            taskId: null,
            canStop: true,
            target: { kind: 'managed', id: block.delegationId, title },
            ...(withLiveDescendants.has(block.delegationId)
              ? { stopsDescendants: true }
              : {}),
          },
        ];
      }
      default:
        return [];
    }
  });
}
