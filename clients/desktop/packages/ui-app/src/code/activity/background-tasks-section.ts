import type { ReactNode } from 'react';
import type { BackgroundTaskStopRequest } from '@canopy/app-core';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
} from '@canopy/protocol/background-tasks';
import type { CollapsedIconColor } from '@canopy/ui-shared/components';
import { isTerminalBackgroundProcessStatus } from '@canopy/ui-shared/lib';

/**
 * Host-only facts the detail modal shows beside the portable task. Hosts build
 * it on demand; nothing here is persisted or sent over a wire.
 */
export interface BackgroundTaskDetail {
  /** Provider task id, shown as "Task ID". */
  readonly providerTaskId?: string;
  /** Tool that launched the task, shown as "Tool". */
  readonly toolName?: string;
  /** Shell command, shown in the replay-blocked "Command" block. */
  readonly command?: string;
  /** Agent prompt, shown in the replay-blocked "Prompt" block. */
  readonly prompt?: string;
  /** Workflow run id, shown as "Run ID" for workflow tasks. */
  readonly runId?: string;
  /**
   * Display value of the "Output file" row; absent shows "not set", null
   * omits the row for a host whose tasks have no output file.
   */
  readonly outputLocationLabel?: string | null;
  /** Opaque handle `readFullOutput` understands; absent shows the task's captured lines. */
  readonly outputSource?: string;
  /** Changes when the host's output backing changes; re-reads and re-arms the flush window. */
  readonly outputGeneration?: string;
  /** Key for `subscribeOutput`; absent means no live output. */
  readonly outputStreamKey?: string;
}

export interface BackgroundTaskFullOutput {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/** One agent of a workflow task, as the background drawer lists it. */
export interface BackgroundWorkflowAgentProgress {
  readonly id: string;
  readonly label: string;
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  /** What the agent last did (its latest tool call), when known. */
  readonly activity: string | null;
}

/** A workflow task's live progress: its phase and its agents. */
export interface BackgroundWorkflowProgress {
  /** The phase running now (or the last one reached), when known. */
  readonly phaseTitle: string | null;
  /** That phase's 0-based position. */
  readonly phaseIndex: number | null;
  readonly phaseCount: number;
  readonly agents: readonly BackgroundWorkflowAgentProgress[];
}

/**
 * What a host can do with its background tasks. Every member is optional; a
 * missing one removes its control or falls back to the DTO.
 */
export interface BackgroundTaskHostActions {
  /** Where `task`'s Stop is sent; absent, or null for a task, means no Stop control. */
  readonly stopTarget?: (
    task: BackgroundTask,
  ) => BackgroundTaskStopRequest | null;
  /** Reports a Stop the host could not send. */
  readonly onStopError?: (error: unknown) => void;
  /** The detail modal opened on `task`, or closed (`null`). */
  readonly onSelectedTaskChange?: (task: BackgroundTask | null) => void;
  readonly getDetail?: (task: BackgroundTask) => BackgroundTaskDetail | null;
  /** Reads the full output behind `BackgroundTaskDetail.outputSource`; may reject. */
  readonly readFullOutput?: (
    outputSource: string,
  ) => Promise<BackgroundTaskFullOutput>;
  /** Live output for `BackgroundTaskDetail.outputStreamKey`; returns an unsubscribe. */
  readonly subscribeOutput?: (
    streamKey: string,
    onLines: (lines: readonly string[]) => void,
  ) => () => void;
  /** Body of the detail modal for `kind: 'workflow'` tasks. */
  readonly renderWorkflowRun?: (task: BackgroundTask) => ReactNode;
  /**
   * Live progress of a `kind: 'workflow'` task; returns an unsubscribe.
   * Subscribed only while its inspector is open. Absent, the drawer shows
   * the task's last progress line and no agent list.
   */
  readonly subscribeWorkflowProgress?: (
    task: BackgroundTask,
    onProgress: (progress: BackgroundWorkflowProgress) => void,
  ) => () => void;
}

/** The host projection the shared ActivityPanel renders the section from. */
export interface BackgroundTasksSectionHostModel {
  readonly tasks: readonly BackgroundTask[];
  readonly actions?: BackgroundTaskHostActions;
  /** Host-owned content rendered beside the shared body (desktop: its UI-state reporter). */
  readonly supplementaryContent?: ReactNode;
}

export interface BackgroundTasksHeaderChrome {
  readonly subtitle: string;
  readonly collapsedIconColor: CollapsedIconColor;
}

/** Section subtitle and collapsed tone; moved verbatim from desktop `useBackgroundProcessesHeaderChrome`. */
export function backgroundTasksHeaderChrome(
  tasks: readonly { readonly status: BackgroundTaskStatus }[],
): BackgroundTasksHeaderChrome {
  const activeCount = tasks.filter(
    (task) => !isTerminalBackgroundProcessStatus(task.status),
  ).length;
  const stoppedCount = tasks.length - activeCount;
  return {
    subtitle:
      tasks.length === 0
        ? 'No agent background activity'
        : `${activeCount} active${stoppedCount > 0 ? `, ${stoppedCount} stopped` : ''}`,
    collapsedIconColor:
      activeCount > 0 ? 'amber' : stoppedCount > 0 ? 'blue' : 'muted',
  };
}
