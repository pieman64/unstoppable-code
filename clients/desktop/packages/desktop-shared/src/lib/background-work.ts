/**
 * Shared answers for a chat's background work (audit D8, D11). Main and the
 * renderer read the same definitions; both inputs are already free of ambient
 * provider tasks.
 */

import type { BackgroundProcessKind } from '../types/activity-panel';

export interface BackgroundDelegationCounts {
  live: number;
  queued: number;
}

export interface BackgroundTaskKind {
  taskType?: string;
}

const CLOSE_BLOCKING_TASK_TYPES = new Set([
  'local_agent',
  'local_workflow',
  'remote_agent',
  'in_process_teammate',
]);
const NON_BLOCKING_TASK_TYPES = new Set(['local_bash', 'mcp_task']);

/**
 * Agents and workflows lose work on close; shells and MCP tasks do not. An
 * unknown type fails safe and blocks; a missing type (older CLIs) does not.
 */
export function isCloseBlockingTaskType(taskType: string | undefined): boolean {
  if (taskType === undefined) return false;
  return (
    CLOSE_BLOCKING_TASK_TYPES.has(taskType) ||
    !NON_BLOCKING_TASK_TYPES.has(taskType)
  );
}

function hasDelegationWork(
  delegations: BackgroundDelegationCounts | undefined,
): boolean {
  return (delegations?.live ?? 0) + (delegations?.queued ?? 0) > 0;
}

/** D11: delegations plus every provider background task, servers included. */
export function hasBackgroundWork(
  delegations: BackgroundDelegationCounts | undefined,
  liveTasks: readonly BackgroundTaskKind[],
): boolean {
  return hasDelegationWork(delegations) || liveTasks.length > 0;
}

/**
 * A summary's running turn (turn-state phases 41a and 41b): a canonical
 * foreground turn, or a dispatched session turn the canonical state hasn't
 * started yet, but never background work alone. `phase` is undefined without
 * canonical state, which leaves the session's answer.
 */
export function summaryTurnActive(
  sessionActive: boolean,
  phase: 'foreground' | 'background' | 'idle' | undefined,
): boolean {
  return phase === 'foreground' || (sessionActive && phase !== 'background');
}

/** D11's background work as a count, for the background spinner (D15). */
export function backgroundTaskCount(
  delegations: BackgroundDelegationCounts | undefined,
  liveTasks: readonly BackgroundTaskKind[],
): number {
  return (
    (delegations?.live ?? 0) + (delegations?.queued ?? 0) + liveTasks.length
  );
}

/** D8: delegations plus provider agents and workflows; never shells. */
export function blocksClose(
  delegations: BackgroundDelegationCounts | undefined,
  liveTasks: readonly BackgroundTaskKind[],
): boolean {
  return (
    hasDelegationWork(delegations) ||
    liveTasks.some((task) => isCloseBlockingTaskType(task.taskType))
  );
}

const TASK_TYPE_KINDS: ReadonlyMap<string, BackgroundProcessKind> = new Map([
  ['local_agent', 'agent'],
  ['remote_agent', 'agent'],
  ['in_process_teammate', 'agent'],
  ['local_workflow', 'workflow'],
  ['local_bash', 'bash'],
  // Monitors watch a WebSocket or MCP server and stream its events.
  ['monitor_ws', 'bash'],
  ['monitor_mcp', 'bash'],
  ['mcp_task', 'task'],
]);

/** Card kind for a provider task type; unknown or missing types are undefined. */
export function backgroundProcessKindForTaskType(
  taskType: string | undefined,
): BackgroundProcessKind | undefined {
  return taskType === undefined ? undefined : TASK_TYPE_KINDS.get(taskType);
}

const TOOL_KINDS: ReadonlyMap<string, BackgroundProcessKind> = new Map([
  ['Bash', 'bash'],
  // Windows Claude sessions expose PowerShell in place of Bash.
  ['PowerShell', 'bash'],
  // Monitor streams a command's (or WebSocket's) events in the background.
  ['Monitor', 'bash'],
  ['Task', 'task'],
  ['Workflow', 'workflow'],
]);

/** Card kind for the tool that launched a process; other tools launch agents. */
export function backgroundProcessKindForTool(
  toolName: string,
): BackgroundProcessKind {
  return TOOL_KINDS.get(toolName) ?? 'agent';
}

/**
 * Claude's acknowledgement that an Agent or Task was launched in the
 * background. Newer CLIs launch agents this way without `run_in_background`,
 * so this text, not the input flag, marks the launch.
 */
export function isAsyncAgentLaunchText(text: string): boolean {
  return /Async agent launched/i.test(text);
}
