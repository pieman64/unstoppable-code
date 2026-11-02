'use client';

import type { BackgroundTaskStopRequest } from '@canopy/app-core';
import { useBackgroundTaskStop, useCapabilities } from '@canopy/app-state';
import { TaskStopButton } from '@canopy/ui-shared/components';
import type { JSX } from 'react';

/** Lead for a host error notice when a background task could not be stopped. */
export const TASK_STOP_FAILED_LABEL = "Couldn't stop the task.";

export interface TaskStopActionProps {
  readonly target: BackgroundTaskStopRequest;
  readonly live: boolean;
  readonly accessibleLabel: string;
  readonly title?: string;
  readonly dataTestId: string;
  readonly onError?: (error: unknown) => void;
  /** Passed to `TaskStopButton`: `false` lets an ancestor see key presses. */
  readonly stopKeyDownPropagation?: boolean;
  /** Passed to `TaskStopButton`: the drawer row's capsule, or the chip. */
  readonly appearance?: 'chip' | 'row' | 'drawer';
}

export function TaskStopAction({
  target,
  live,
  accessibleLabel,
  title,
  dataTestId,
  onError,
  stopKeyDownPropagation,
  appearance,
}: TaskStopActionProps): JSX.Element | null {
  const capabilities = useCapabilities();
  const { stopping, stop } = useBackgroundTaskStop(target, live);

  if (capabilities.backgroundTaskStop !== true || !live) {
    return null;
  }

  const handleStop = (): void => {
    if (stopping) return;
    void stop().catch((error: unknown) => onError?.(error));
  };

  return (
    <TaskStopButton
      stopping={stopping}
      onStop={handleStop}
      accessibleLabel={accessibleLabel}
      title={title}
      dataTestId={dataTestId}
      stopKeyDownPropagation={stopKeyDownPropagation}
      appearance={appearance}
    />
  );
}
