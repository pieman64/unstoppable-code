import {
  agentActionIdempotencyKey,
  agentActionToolResult,
  agentActionResult,
  lineageOf,
  missingScopeResponse,
  portErrorResponse,
  runIdempotentWrite,
} from '../action-support';
import type { AgentActionLimitsPort } from '../limits';
import type { AgentActionSplitPort } from '../surface/engine';
import type { AgentActionCall, AgentActionCallScope } from '../surface/family';
import { AGENT_ACTION_TOOL_DISPLAY_NAMES } from '../tool-keys';
import type { AgentActionToolResult } from '../tools/definition';
import type { AgentActionReceiptStore } from '../receipts';
import type { AgentEnvironmentPort } from './environment-port';

export interface AgentForkChatInput {
  scope: AgentActionCallScope;
  followUpInstruction: string;
  lineage: { parentChatId: string; depth: number };
  idempotencyKey: string;
}

export interface AgentForkChatReceipt {
  chatId: string;
  worktreeId: string;
  /** Saved transcript copied into a new native session, without hidden state. */
  contextTransfer?: 'transcript';
}

/** Host-side fork of the calling chat into an independent chat. */
export interface AgentForkPort<H> {
  forkChat(
    input: AgentForkChatInput,
    call: AgentActionCall<H>,
  ): Promise<AgentForkChatReceipt>;
}

/**
 * The split-agent tools over a fork port. Forks count against the limits;
 * branched agents need a host with local worktrees and are not offered.
 */
export function createForkSplitPort<H>(options: {
  fork: AgentForkPort<H>;
  environment: Pick<AgentEnvironmentPort<H>, 'callerDepth'>;
  limits: AgentActionLimitsPort | null;
  /** The same receipt store the host's environment family uses. */
  receipts: AgentActionReceiptStore<H>;
}): AgentActionSplitPort<H> {
  const type = AGENT_ACTION_TOOL_DISPLAY_NAMES.start_forked_agent;
  return {
    start: async (kind, input, call): Promise<AgentActionToolResult> => {
      if (kind === 'branched') {
        return {
          text: `${AGENT_ACTION_TOOL_DISPLAY_NAMES.start_branched_agent} is not available in this chat.`,
          isError: true,
        };
      }
      const scope = call.scope;
      if (!scope)
        return agentActionToolResult(missingScopeResponse(call, type));
      try {
        const idempotencyKey = agentActionIdempotencyKey(type, call, input);
        return await runIdempotentWrite({
          receipts: options.receipts,
          limits: options.limits,
          kind: 'fork',
          call,
          idempotencyKey,
          payload: input,
          prepare: async () => {
            const depth = await options.environment.callerDepth(call);
            return {
              ok: true,
              parentDepth: depth,
              write: async (): Promise<AgentActionToolResult> => {
                const receipt = await options.fork.forkChat(
                  {
                    scope,
                    followUpInstruction: input.followUpInstruction,
                    lineage: lineageOf(scope, depth),
                    idempotencyKey,
                  },
                  call,
                );
                return agentActionToolResult(
                  agentActionResult(call, type, {
                    chatId: receipt.chatId,
                    worktreeId: receipt.worktreeId,
                    independent: true,
                    ...(receipt.contextTransfer
                      ? { contextTransfer: receipt.contextTransfer }
                      : {}),
                  }),
                );
              },
            };
          },
        });
      } catch (error) {
        return agentActionToolResult(portErrorResponse(call, type, error));
      }
    },
  };
}
