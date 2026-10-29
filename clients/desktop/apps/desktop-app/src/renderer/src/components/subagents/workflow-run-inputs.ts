import { getModelDisplayName } from '@canopy/agent-transcript/lib/model-resolver';
import type {
  WorkflowAgentInputState,
  WorkflowRunSubagentInput,
} from '@canopy/agent-transcript';
import type {
  BackgroundProcess,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';
import type { WorkflowRunLocation } from './workflow-run-launches';

export const WORKFLOW_RUN_RECENT_ACTIVITY_MS = 30 * 60_000;

export type WorkflowRunInputStatus = WorkflowRunSubagentInput['status'];

/** Terminal mapping of a run-state status string, or null when not terminal. */
export function terminalWorkflowRunStatus(
  status: string | undefined,
): Exclude<WorkflowRunInputStatus, 'running'> | null {
  switch (status?.trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'stopped':
    case 'killed':
      return 'interrupted';
    default:
      return null;
  }
}

/** Whether a matching background process for this run is queued or running. */
export function hasLiveWorkflowProcess(
  processes: readonly BackgroundProcess[],
  run: {
    readonly runId: string;
    readonly taskId?: string;
    readonly toolUseId?: string;
  },
): boolean {
  return processes.some(
    (process) =>
      (process.status === 'queued' || process.status === 'running') &&
      (process.runId === run.runId ||
        (run.taskId !== undefined &&
          (process.taskId === run.taskId ||
            process.outputTaskId === run.taskId)) ||
        (run.toolUseId !== undefined && process.toolUseId === run.toolUseId)),
  );
}

/** Derive tree status from final run state, host liveness, and recent activity. */
export function workflowRunStatus(
  state: WorkflowRunState | null,
  options: { readonly liveProcess: boolean; readonly now: number },
): WorkflowRunInputStatus {
  const terminalStatus = terminalWorkflowRunStatus(state?.status);
  if (terminalStatus !== null) return terminalStatus;
  if (options.liveProcess) return 'running';
  if (
    state?.lastActivityAt !== undefined &&
    options.now - state.lastActivityAt <= WORKFLOW_RUN_RECENT_ACTIVITY_MS
  ) {
    return 'running';
  }
  return 'interrupted';
}

/** Map the workflow journal's free-form agent state to the tree lifecycle. */
export function workflowAgentInputState(
  state: string,
): WorkflowAgentInputState {
  switch (state.trim().toLowerCase()) {
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'queued';
    case 'running':
    case 'started':
    case 'in_progress':
    case 'inprogress':
    case 'active':
      return 'running';
    case 'done':
    case 'completed':
    case 'complete':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'error':
    case 'failed':
    case 'failure':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'stopped':
    case 'killed':
    case 'aborted':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

/** Map a desktop run projection to the portable subagent tree input. */
export function workflowRunSubagentInput(
  location: Pick<WorkflowRunLocation, 'runId' | 'name' | 'launchedAt'>,
  state: WorkflowRunState | null,
  status: WorkflowRunInputStatus,
): WorkflowRunSubagentInput {
  const startedAt = state?.startedAt ?? location.launchedAt;
  const settledAgentTimes =
    status === 'running'
      ? []
      : (state?.agents.flatMap((agent) =>
          agent.settledAt === undefined ? [] : [agent.settledAt],
        ) ?? []);
  // The recorded run duration wins: a run can keep working after its last
  // agent settles. Agent times are the fallback when none was recorded.
  const settledAt =
    status === 'running'
      ? undefined
      : state?.durationMs !== undefined && startedAt !== undefined
        ? startedAt + state.durationMs
        : settledAgentTimes.length > 0
          ? Math.max(...settledAgentTimes)
          : undefined;
  const name = state?.workflowName?.trim() || location.name;

  return {
    runId: location.runId,
    name,
    status,
    startedAt,
    ...(settledAt !== undefined ? { settledAt } : {}),
    phases: state?.phases.map((phase) => ({ title: phase.title })) ?? [],
    agents:
      state?.agents.flatMap((agent) => {
        if (!/^[A-Za-z0-9_-]+$/.test(agent.agentId)) return [];
        return [
          {
            agentId: agent.agentId,
            label: agent.label,
            ...(agent.phaseTitle ? { phaseTitle: agent.phaseTitle } : {}),
            state: workflowAgentInputState(agent.state),
            ...(agent.model
              ? { modelLabel: getModelDisplayName(agent.model) }
              : {}),
            ...(agent.promptPreview !== undefined
              ? { prompt: agent.promptPreview }
              : {}),
            ...(agent.startedAt !== undefined
              ? { startedAt: agent.startedAt }
              : {}),
            ...(agent.settledAt !== undefined
              ? { settledAt: agent.settledAt }
              : {}),
            ...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
            ...(agent.toolCalls !== undefined
              ? { toolCalls: agent.toolCalls }
              : {}),
            ...(agent.durationMs !== undefined
              ? { durationMs: agent.durationMs }
              : {}),
            ...(agent.error !== undefined ? { errorMessage: agent.error } : {}),
          },
        ];
      }) ?? [],
  };
}
