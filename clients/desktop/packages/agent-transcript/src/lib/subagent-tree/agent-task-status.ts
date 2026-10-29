import {
  AGENT_TASK_STATUSES,
  AGENT_TASK_STOP_REASONS,
  type AgentTaskStatus,
  type AgentTaskStopReason,
} from '@canopy/protocol/cloud-session';
import type { SubagentStatus } from './index';

/** Error shown for a task whose sandbox stopped under it. */
export const AGENT_TASK_LOST_ERROR = 'Lost when the sandbox stopped';

/** A task's status in the shared Subagents panel vocabulary. */
export interface AgentTaskSubagentState {
  readonly status: SubagentStatus;
  readonly approvalPending: boolean;
  readonly errorMessage?: string;
}

export function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  return AGENT_TASK_STATUSES.some((status) => status === value);
}

export function isAgentTaskStopReason(
  value: unknown,
): value is AgentTaskStopReason {
  return AGENT_TASK_STOP_REASONS.some((reason) => reason === value);
}

function failed(errorMessage: string | null): AgentTaskSubagentState {
  return errorMessage
    ? { status: 'failed', approvalPending: false, errorMessage }
    : { status: 'failed', approvalPending: false };
}

/** Maps an agent task's lifecycle onto the panel's shared statuses. */
export function agentTaskSubagentState(input: {
  readonly status: AgentTaskStatus;
  readonly approvalPending: boolean;
  readonly stopReason: AgentTaskStopReason | null;
  readonly startedAt: number | null;
  readonly errorMessage: string | null;
}): AgentTaskSubagentState {
  switch (input.status) {
    case 'pending':
      return {
        status: input.startedAt === null ? 'queued' : 'starting',
        approvalPending: false,
      };
    case 'running':
      return { status: 'running', approvalPending: false };
    case 'waiting':
      return input.approvalPending
        ? { status: 'approval', approvalPending: true }
        : { status: 'idle', approvalPending: false };
    case 'completed':
      return { status: 'completed', approvalPending: false };
    case 'failed':
      return failed(input.errorMessage);
    case 'cancelled':
      return {
        status:
          input.stopReason === 'parent' ? 'stopped-by-parent' : 'cancelled',
        approvalPending: false,
      };
    case 'interrupted':
      return { status: 'interrupted', approvalPending: false };
    case 'lost':
      return failed(AGENT_TASK_LOST_ERROR);
  }
}
