/**
 * Agent task vocabulary, mirroring agentic-core
 * `libs/workflow-contracts/src/agent-task.ts` (REG-3067).
 */

export const AGENT_TASK_KINDS = ['subagent', 'background_shell'] as const;
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];

export const AGENT_TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AGENT_TASK_HARNESSES = [
  'CLAUDE_CODE',
  'CODEX',
  'TOOL_LOOP',
] as const;
export type AgentTaskHarness = (typeof AGENT_TASK_HARNESSES)[number];

export const AGENT_TASK_STOP_REASONS = [
  'user',
  'parent',
  'inactivity',
  'budget',
  'session_ended',
] as const;
export type AgentTaskStopReason = (typeof AGENT_TASK_STOP_REASONS)[number];

export const AGENT_TASK_PROMPT_MAX_CHARS = 4000;
export const AGENT_TASK_SUMMARY_MAX_CHARS = 4000;
export const AGENT_TASK_OUTPUT_TAIL_MAX_CHARS = 8000;

/** Harness-native ids of one task. Every field is optional. */
export interface AgentTaskNativeIds {
  readonly toolUseId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly threadId?: string;
  readonly callId?: string;
  readonly shellId?: string;
  /**
   * The session's root Codex thread. Metadata only: never part of the task
   * identity, so tasks sharing a root stay separate.
   */
  readonly rootThreadId?: string;
  /**
   * Codex's agent identity path, such as `/root/readme_review`. A harness
   * identity, not a filesystem path; metadata only, like `rootThreadId`.
   */
  readonly agentPath?: string;
  /**
   * The harness tool that started a background task, such as `Bash` or
   * `Monitor` (REG-3081). Absent on rows from an older Core.
   */
  readonly toolName?: string;
}

export const AGENT_TASK_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
] as const satisfies readonly AgentTaskStatus[];

export function isAgentTaskTerminalStatus(status: AgentTaskStatus): boolean {
  return AGENT_TASK_TERMINAL_STATUSES.some((terminal) => terminal === status);
}

/**
 * A task's own stream key under its turn (REG-3067 `agentTaskSourceKey`). A
 * nested spawn call carries its parent task's key as its source key.
 */
export function agentTaskSourceKey(
  turnSourceKey: string,
  taskId: string,
): string {
  return `${turnSourceKey}:task:${taskId}`;
}

/** Deepest nesting the runner allows (`AGENT_TASK_MAX_DEPTH`, REG-3067). */
export const AGENT_TASK_MAX_DEPTH = 8;

/**
 * Live background tasks a session may run (`AGENT_TASK_MAX_CONCURRENT_BACKGROUND`,
 * REG-3081); Core fails the next with error code `task_limit`.
 */
export const AGENT_TASK_MAX_CONCURRENT_BACKGROUND = 16;

/**
 * Client-announced conversation capability (REG-3067
 * `AGENT_CONVERSATION_TASKS_CAPABILITY`). Core sends task data only to
 * clients that announce it.
 */
export const AGENT_CONVERSATION_TASKS_CAPABILITY = 'agent_tasks' as const;
