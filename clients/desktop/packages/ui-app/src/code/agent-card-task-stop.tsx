'use client';

import { createContext, useContext, type JSX } from 'react';
import type { BackgroundTaskStopRequest } from '@canopy/app-core';
import { TaskStopAction } from './activity/TaskStopAction';

/** Accessible name of a transcript agent card's Stop, as desktop names it. */
const AGENT_TASK_STOP_LABEL = 'Stop agent';

/**
 * How a host stops a provider-native agent from its transcript card. Absent,
 * cards offer no Stop. The host decides per task (its chat's capabilities).
 */
export interface AgentCardTaskStopHost {
  readonly stopTarget: (taskId: string) => BackgroundTaskStopRequest | null;
  readonly onStopError?: (error: unknown) => void;
}

export const AgentCardHeaderActionContext =
  createContext<AgentCardTaskStopHost | null>(null);

const LIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'waiting',
]);

/** Whether an agent part's task can take Stop now, by its own fields. */
export function agentPartTaskStoppable(data: {
  readonly taskId?: unknown;
  readonly taskStatus?: unknown;
  readonly taskStoppable?: unknown;
}): data is { readonly taskId: string } {
  return (
    typeof data.taskId === 'string' &&
    data.taskId !== '' &&
    typeof data.taskStatus === 'string' &&
    LIVE_TASK_STATUSES.has(data.taskStatus) &&
    data.taskStoppable === true
  );
}

/** A Claude agent card's "Stop agent", when the host can stop its task. */
export function AgentCardTaskStopAction({
  taskId,
}: {
  readonly taskId: string;
}): JSX.Element | null {
  const host = useContext(AgentCardHeaderActionContext);
  const target = host?.stopTarget(taskId) ?? null;
  if (host === null || target === null) return null;
  return (
    <TaskStopAction
      target={target}
      live
      accessibleLabel={AGENT_TASK_STOP_LABEL}
      dataTestId="agent-task-stop"
      onError={host.onStopError}
    />
  );
}
