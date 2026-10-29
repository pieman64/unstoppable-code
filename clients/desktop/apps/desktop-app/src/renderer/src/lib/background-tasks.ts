import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';

/**
 * Projects a desktop background process onto the portable `BackgroundTask`
 * the shared UI renders. Host-local fields (output file, transcript and script
 * paths, provider task ids) stay on the process.
 */
export function backgroundProcessToTask(
  process: BackgroundProcess,
): BackgroundTask {
  const settled =
    process.status === 'completed' ||
    process.status === 'failed' ||
    process.status === 'stopped';
  return {
    id: process.id,
    kind: process.kind,
    status: process.status,
    title: process.description,
    ownerToolUseId: process.toolUseId,
    // Desktop does not track which background task started another.
    parentTaskId: null,
    startedAt: process.startedAt,
    // Desktop keeps no separate settle time; a terminal process's last update
    // is the notification that settled it.
    settledAt: settled ? process.updatedAt : null,
    updatedAt: process.updatedAt,
    lastDescription: process.lastDescription ?? null,
    summary: process.summary ?? null,
    outputLines: process.outputLines,
    // Stop needs the provider task id, so desktop offers it only once known.
    canStop: process.canStop && process.taskId !== undefined,
  };
}
