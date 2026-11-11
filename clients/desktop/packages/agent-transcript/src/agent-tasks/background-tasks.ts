/**
 * Agent task rows as the portable `BackgroundTask` the shared background
 * drawer and Activity section render (CAN-4050 part A; shared by the web and
 * desktop cloud chats since CAN-5976).
 *
 * A row is background work when Core says so: a `background_shell` (a Claude
 * `run_in_background` Bash or Monitor, a Codex background terminal), a
 * subagent with `background: true`, or a kind this build does not know yet
 * while it is live, so no live work is ever hidden (security B1).
 */
import type {
  BackgroundTask,
  BackgroundTaskKind,
  BackgroundTaskStatus,
} from '@canopy/protocol/background-tasks';
import {
  AGENT_TASK_MAX_CONCURRENT_BACKGROUND,
  type AgentTaskRow,
  type AgentTaskStopReason,
} from '@canopy/protocol/cloud-session';

export interface AgentTaskBackgroundTaskOptions {
  /**
   * Whether the chat can stop `task` now (CAN-5205: the task's `stoppable`
   * and the chat's `agentTaskStop` capability). Absent means no Stop.
   */
  readonly canStop?: (task: AgentTaskRow) => boolean;
}

const SHELL_TOOL_NAME = 'Bash';
const UNTITLED_TASK = 'Background task';

const STOP_LINES: Record<AgentTaskStopReason, string> = {
  user: 'Stopped',
  parent: 'Stopped with its parent agent',
  inactivity: 'Stopped because the chat was idle',
  budget: 'Stopped at the background work limit',
  // Desktop's line for a task its chat session took down.
  session_ended: 'Stopped when the chat session ended',
};

/** Core's error code for a task stopped past the background task limit. */
const TASK_LIMIT_ERROR = 'task_limit';
const TASK_LIMIT_LINE = `Stopped because ${AGENT_TASK_MAX_CONCURRENT_BACKGROUND} background tasks were already running`;

function isBackgroundRow(task: AgentTaskRow): boolean {
  if (task.kind === 'background_shell') return true;
  if (task.kind === 'subagent') return task.background;
  return task.kind === 'unknown' && !isSettled(taskStatus(task));
}

function taskKind(task: AgentTaskRow): BackgroundTaskKind {
  if (task.kind === 'subagent') return 'agent';
  if (task.kind === 'background_shell') {
    const toolName = task.native.toolName;
    return toolName === undefined || toolName === SHELL_TOOL_NAME
      ? 'bash'
      : 'task';
  }
  return 'task';
}

function taskStatus(task: AgentTaskRow): BackgroundTaskStatus {
  switch (task.status) {
    case 'pending':
      return 'queued';
    case 'running':
    case 'waiting':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'lost':
      return 'failed';
    case 'cancelled':
    case 'interrupted':
      return 'stopped';
    case 'unknown':
      return task.completedAtMs === null ? 'running' : 'completed';
  }
}

function isSettled(status: BackgroundTaskStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

function firstLine(text: string | null): string | null {
  const line = text?.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? null : line.trim();
}

function taskSummary(
  task: AgentTaskRow,
  status: BackgroundTaskStatus,
): string | null {
  if (task.summary !== null) return task.summary;
  if (status === 'failed')
    return task.error?.code === TASK_LIMIT_ERROR
      ? TASK_LIMIT_LINE
      : (task.error?.message ?? null);
  if (status === 'stopped' && task.stopReason !== null)
    return STOP_LINES[task.stopReason];
  return null;
}

function outputLines(tail: string | null): readonly string[] {
  if (tail === null || tail === '') return [];
  const lines = tail.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The portable task for one Core row, or null when it is not background work. */
export function agentTaskBackgroundTask(
  task: AgentTaskRow,
  options: AgentTaskBackgroundTaskOptions = {},
): BackgroundTask | null {
  if (!isBackgroundRow(task)) return null;
  const status = taskStatus(task);
  const settled = isSettled(status);
  const startedAt = task.startedAtMs ?? task.createdAtMs;
  const settledAt = settled
    ? (task.completedAtMs ?? task.updatedAtMs ?? startedAt)
    : null;
  return {
    id: task.taskId,
    kind: taskKind(task),
    status,
    title:
      task.description ??
      task.title ??
      firstLine(task.prompt) ??
      task.native.toolName ??
      UNTITLED_TASK,
    ownerToolUseId: task.spawnToolCallId,
    parentTaskId: task.parentTaskId,
    startedAt,
    settledAt,
    updatedAt:
      task.updatedAtMs ?? task.completedAtMs ?? startedAt ?? settledAt ?? 0,
    lastDescription: task.progress ?? task.description,
    summary: taskSummary(task, status),
    outputLines: outputLines(task.outputTail),
    canStop: !settled && options.canStop?.(task) === true,
  };
}

/** Every background task among `tasks`, newest change first. */
export function agentTaskBackgroundTasks(
  tasks: Iterable<AgentTaskRow>,
  options: AgentTaskBackgroundTaskOptions = {},
): BackgroundTask[] {
  const mapped: BackgroundTask[] = [];
  for (const task of tasks) {
    const background = agentTaskBackgroundTask(task, options);
    if (background !== null) mapped.push(background);
  }
  return mapped.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
}

/** Whether `task` is background work that still runs. */
export function isLiveBackgroundTask(task: BackgroundTask): boolean {
  return !isSettled(task.status);
}
