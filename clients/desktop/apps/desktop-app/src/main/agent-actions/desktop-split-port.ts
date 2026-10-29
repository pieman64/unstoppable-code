import {
  AGENT_ACTION_TOOL_DISPLAY_NAMES,
  agentActionIdempotencyKey,
  runIdempotentWrite,
  type AgentActionReceiptStore,
  type AgentActionSplitPort,
  type AgentActionToolResult,
  type AgentForkChatReceipt,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';

type DesktopSplitKind = 'start_forked_agent' | 'start_branched_agent';

type DesktopSplitScope = NonNullable<
  CanopyInjectedToolRuntime['worktreeActionRuntime']
>;

export interface DesktopSplitResult {
  ok: true;
  chatId: string;
  worktreeId: string;
  delivery: 'submitted';
  independent: true;
  contextTransfer?: AgentForkChatReceipt['contextTransfer'];
}

export interface DesktopSplitPortDeps {
  /** The split-agent runtime that forks or branches the calling chat. */
  startSplitAgent(
    kind: DesktopSplitKind,
    input: { followUpInstruction: string },
    scope: DesktopSplitScope,
  ): Promise<DesktopSplitResult>;
}

/**
 * StartForkedAgent / StartBranchedAgent over the split-agent runtime. A
 * retried call returns the result it started with from the shared receipt
 * store, keyed like every other agent write; forks do not count against the
 * limits on desktop.
 */
export function createDesktopSplitPort(
  deps: DesktopSplitPortDeps & {
    receipts: AgentActionReceiptStore<CanopyInjectedToolRuntime>;
  },
): AgentActionSplitPort<CanopyInjectedToolRuntime> {
  return {
    start: async (kind, input, call): Promise<AgentActionToolResult> => {
      const key: DesktopSplitKind =
        kind === 'branched' ? 'start_branched_agent' : 'start_forked_agent';
      const scope = call.host.worktreeActionRuntime;
      // Forks stay in the source's own Work Entry, so directory-scoped Cowork
      // chats may fork; branching needs a Code worktree.
      if (
        !scope ||
        (key === 'start_branched_agent' &&
          (scope.executionScope ?? 'worktree') !== 'worktree')
      ) {
        return {
          text:
            key === 'start_branched_agent'
              ? 'Starting branched agents is only available for worktree chats.'
              : 'Starting forked agents is only available for worktree and Cowork chats.',
          isError: true,
        };
      }
      const signal =
        call.signal && scope.signal
          ? AbortSignal.any([call.signal, scope.signal])
          : (call.signal ?? scope.signal);
      const source = signal ? { ...scope, signal } : scope;
      try {
        return await runIdempotentWrite({
          receipts: deps.receipts,
          limits: null,
          kind: 'fork',
          call,
          payload: { tool: key, ...input },
          idempotencyKey: agentActionIdempotencyKey(
            AGENT_ACTION_TOOL_DISPLAY_NAMES[key],
            call,
            input,
          ),
          prepare: () =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (): Promise<AgentActionToolResult> => {
                // Completed receipts still replay after cancellation; only a
                // new dispatch observes the current turn's lifetime.
                signal?.throwIfAborted();
                return {
                  text: JSON.stringify(
                    await deps.startSplitAgent(key, input, source),
                  ),
                };
              },
            }),
        });
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

/** Loads the split-agent runtime on first use and runs it. */
export const startDesktopSplitAgent: DesktopSplitPortDeps['startSplitAgent'] =
  async (kind, input, scope) => {
    // This local module pulls in worktree creation and provider runtime
    // code; keep it lazy so the shared tool executor does not add that
    // cost to normal Electron main startup. The E2E build verifies the
    // packaged import path.
    const { startSplitAgent } =
      await import('../canopy-tools/start-split-agent-runtime');
    return startSplitAgent(kind, input, scope);
  };
