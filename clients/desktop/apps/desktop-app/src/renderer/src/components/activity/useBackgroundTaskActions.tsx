import { useMemo, type JSX, type ReactNode } from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type {
  BackgroundTaskDetail,
  BackgroundTaskHostActions,
} from '@canopy/ui-app';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { WorkflowRunView } from './WorkflowRunView';
import { isTerminalStatus } from './utils';

/**
 * Every failure shape that means "this task is already gone", mapped to the
 * terminal status the card should adopt. Main resolves a stop for a dead task
 * successfully now, but the request can still fail this way — the chat's
 * provider session can disappear between the click and the IPC, and the
 * message arrives wrapped in Electron's `Error invoking remote method …`
 * prefix. Leaving it unrecognized left a `running` card that the Stop button
 * could never clear. A refusal that says nothing about the task's state (a
 * Codex session, for instance) stays unresolved.
 */
export function extractTerminalStatusFromStopError(
  error: unknown,
): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  if (!message) return null;

  const match = /status:\s*([a-z_]+)/i.exec(message);
  const status = match?.[1]?.toLowerCase();
  if (
    status === 'killed' ||
    status === 'stopped' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    status === 'failed' ||
    status === 'completed'
  ) {
    return status;
  }

  return /no active session|not running|unknown task|no such task/i.test(
    message,
  )
    ? 'stopped'
    : null;
}

function backgroundProcessDetail(
  process: BackgroundProcess,
): BackgroundTaskDetail {
  return {
    providerTaskId: process.taskId,
    toolName: process.toolName,
    command: process.command,
    prompt: process.prompt,
    runId: process.runId,
    outputLocationLabel: process.outputFile,
    outputSource: process.outputFile,
    outputGeneration: process.outputTaskId,
    outputStreamKey: process.outputTaskId ?? process.taskId,
  };
}

/** The workflow body the modal used to render inline; mounted only for workflow tasks. */
// eslint-disable-next-line react-refresh/only-export-components
function DesktopWorkflowRunBody({
  process,
}: {
  readonly process: BackgroundProcess;
}): JSX.Element {
  const workflow = useWorkflowRun(
    process.transcriptDir,
    process.runId,
    isTerminalStatus(process.status),
  );
  return (
    <WorkflowRunView
      run={workflow.run}
      transcriptDir={process.transcriptDir}
      loading={workflow.loading}
    />
  );
}

export function useBackgroundTaskActions({
  projectId,
  worktreeId,
  processes,
  onSelectedTaskIdChange,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly processes: readonly BackgroundProcess[];
  /** Receives the provider task id of the process whose modal opened, or null. */
  readonly onSelectedTaskIdChange?: (taskId: string | null) => void;
}): BackgroundTaskHostActions {
  const handleSdkSystemEvent = useActivityStore(
    (state) => state.handleSdkSystemEvent,
  );
  return useMemo((): BackgroundTaskHostActions => {
    const findProcess = (task: BackgroundTask): BackgroundProcess | undefined =>
      processes.find((process) => process.id === task.id);
    return {
      stop: async (task): Promise<void> => {
        const process = findProcess(task);
        const taskId = process?.taskId;
        if (!process || !taskId) return;
        try {
          const stopOutcome = await window.api.activity.stopBgProcess({
            projectId,
            worktreeId,
            chatId: process.chatId,
            taskId,
          });

          if (stopOutcome === 'stopped') {
            handleSdkSystemEvent(projectId, worktreeId, process.chatId, {
              type: 'system',
              subtype: 'task_notification',
              task_id: taskId,
              status: 'stopped',
              summary: 'Background process stopped.',
            });
          }
        } catch (error) {
          const terminalStatus = extractTerminalStatusFromStopError(error);
          if (terminalStatus) {
            handleSdkSystemEvent(projectId, worktreeId, process.chatId, {
              type: 'system',
              subtype: 'task_notification',
              task_id: taskId,
              status: terminalStatus,
              summary: 'Background process is no longer running.',
            });
            return;
          }
          // eslint-disable-next-line no-console
          console.error('Failed to stop background process', {
            taskId,
            error,
          });
        }
      },
      onSelectedTaskChange: onSelectedTaskIdChange
        ? (task): void =>
            onSelectedTaskIdChange(
              task ? (findProcess(task)?.taskId ?? null) : null,
            )
        : undefined,
      getDetail: (task): BackgroundTaskDetail | null => {
        const process = findProcess(task);
        return process ? backgroundProcessDetail(process) : null;
      },
      readFullOutput: (outputSource) =>
        window.api.activity.readFullOutput({ outputFile: outputSource }),
      subscribeOutput: (streamKey, onLines) =>
        window.api.activity.onBgProcessOutput((event) => {
          if (event.taskId !== streamKey) return;
          onLines(event.lines);
        }),
      renderWorkflowRun: (task): ReactNode => {
        const process = findProcess(task);
        return process ? <DesktopWorkflowRunBody process={process} /> : null;
      },
    };
  }, [
    handleSdkSystemEvent,
    onSelectedTaskIdChange,
    processes,
    projectId,
    worktreeId,
  ]);
}
