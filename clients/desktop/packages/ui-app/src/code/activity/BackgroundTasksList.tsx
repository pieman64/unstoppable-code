'use client';

import { memo, useEffect, useState, type JSX } from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type { BackgroundTaskHostActions } from './background-tasks-section';
import { BackgroundProcessesSectionBody } from './BackgroundProcessesSectionBody';
import { BackgroundTaskDetailModal } from './BackgroundTaskDetailModal';

/**
 * The Agent Background Processes card body plus its stop and detail-modal
 * behavior, without the activity-panel section chrome. The panel section and
 * the chat transcript's Agent activity section both render this, so a
 * background process looks and behaves identically wherever it surfaces.
 */
export interface BackgroundTasksListProps {
  readonly tasks: readonly BackgroundTask[];
  readonly actions?: BackgroundTaskHostActions;
}

export const BackgroundTasksList = memo(function BackgroundTasksList({
  tasks,
  actions,
}: BackgroundTasksListProps): JSX.Element {
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTask = selectedTaskId
    ? (tasks.find((task) => task.id === selectedTaskId) ?? null)
    : null;
  const onSelectedTaskChange = actions?.onSelectedTaskChange;
  useEffect(() => {
    if (selectedTaskId && !selectedTask) {
      setSelectedTaskId(null);
      onSelectedTaskChange?.(null);
    }
  }, [onSelectedTaskChange, selectedTask, selectedTaskId]);

  const stop = actions?.stop;
  const handleStop = async (task: BackgroundTask): Promise<void> => {
    if (!stop || !task.canStop || stoppingTaskId === task.id) return;
    setStoppingTaskId(task.id);
    try {
      await stop(task);
    } catch {
      // The host reports its own stop failures; the contract says stop never rejects.
    } finally {
      setStoppingTaskId((current) => (current === task.id ? null : current));
    }
  };
  const handleOpenDetail = (task: BackgroundTask): void => {
    setSelectedTaskId(task.id);
    onSelectedTaskChange?.(task);
  };
  const handleCloseDetail = (): void => {
    setSelectedTaskId(null);
    onSelectedTaskChange?.(null);
  };
  return (
    <>
      <BackgroundProcessesSectionBody
        tasks={tasks}
        stoppingTaskId={stoppingTaskId}
        onStop={stop ? (task): void => void handleStop(task) : undefined}
        onOpenDetail={handleOpenDetail}
      />
      {selectedTask && (
        <BackgroundTaskDetailModal
          task={selectedTask}
          actions={actions}
          onClose={handleCloseDetail}
          onStop={stop ? (): void => void handleStop(selectedTask) : undefined}
          isStopping={stoppingTaskId === selectedTask.id}
        />
      )}
    </>
  );
});
