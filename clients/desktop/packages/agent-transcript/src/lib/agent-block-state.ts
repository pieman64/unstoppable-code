import type { BackgroundTaskStatus } from '@canopy/protocol/background-tasks';
import type { DisplayBlock, ToolResult } from '../message-display';
import { claudeLaunchedAgentId, isPendingTaskOutput } from './claude-agent-id';

export function isClaudeAgentRunning(
  runInBackground: boolean,
  result?: ToolResult,
  taskOutputResult?: ToolResult,
  backgroundStatus?: BackgroundTaskStatus,
): boolean {
  if (backgroundStatus)
    return backgroundStatus === 'queued' || backgroundStatus === 'running';
  if (taskOutputResult && !isPendingTaskOutput(taskOutputResult.output))
    return false;
  if (!result) return true;
  // A background launch acknowledgement is not the child's final result. An
  // async launch says so even without `run_in_background`.
  if (result.isError) return false;
  if (/Async agent launched/i.test(result.output)) return true;
  if (claudeLaunchedAgentId(result.output) !== undefined)
    return runInBackground;
  return false;
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
