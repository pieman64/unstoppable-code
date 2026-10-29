import type { BackgroundTaskStatus } from '@canopy/protocol/background-tasks';
import type { DisplayBlock, ToolResult } from '../message-display';

export function isClaudeAgentRunning(
  runInBackground: boolean,
  result?: ToolResult,
  taskOutputResult?: ToolResult,
  backgroundStatus?: BackgroundTaskStatus,
): boolean {
  if (backgroundStatus)
    return backgroundStatus === 'queued' || backgroundStatus === 'running';
  if (taskOutputResult) return false;
  if (!result) return true;
  // A background launch acknowledgement is not the child's final result.
  return (
    runInBackground &&
    !result.isError &&
    /Async agent launched|agentId:\s*[a-f0-9-]+/i.test(result.output)
  );
}

export function codexAgentState(
  block: Pick<
    Extract<DisplayBlock, { type: 'codex_agent' }>,
    'status' | 'agentsStates'
  >,
): { running: boolean; error: boolean } {
  const states = Object.values(block.agentsStates);
  const error =
    block.status === 'failed' ||
    states.some((state) => state.status === 'errored');
  return {
    error,
    running:
      !error &&
      (block.status === 'inProgress' ||
        states.some(
          (state) =>
            state.status === 'pendingInit' || state.status === 'running',
        )),
  };
}
