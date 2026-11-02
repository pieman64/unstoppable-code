'use client';

import type { JSX } from 'react';
import { StopAllConfirmControl } from './StopAllConfirmControl';

const BACKGROUND_WORK_STOP_ALL_LABEL = 'Stop all background work';

function backgroundWorkStopAllPrompt(count: number): string {
  return `Stop ${count} background ${count === 1 ? 'task' : 'tasks'}?`;
}

export interface StopAllBackgroundWorkControlProps {
  /** The chat's live background work a Stop all covers. */
  readonly liveTaskIds: readonly string[];
  /** Stops it all; resolves `true` once the host accepted it. */
  readonly onStopAll: () => Promise<boolean>;
  readonly appearance?: 'default' | 'section';
  readonly testId?: string;
}

/**
 * Stop all background work of one chat (security B6): every live background
 * task and agent, chosen by the host's backend, after an inline
 * confirmation. Hosts key it by chat so a confirmation never carries over.
 */
export function StopAllBackgroundWorkControl({
  liveTaskIds,
  onStopAll,
  appearance = 'default',
  testId = 'background-tray-stop-all-work',
}: StopAllBackgroundWorkControlProps): JSX.Element | null {
  return (
    <StopAllConfirmControl
      liveIds={liveTaskIds}
      onStopAll={onStopAll}
      label={BACKGROUND_WORK_STOP_ALL_LABEL}
      accessibleLabel={BACKGROUND_WORK_STOP_ALL_LABEL}
      prompt={backgroundWorkStopAllPrompt}
      appearance={appearance}
      message="This stops every background task in this chat."
      testId={testId}
    />
  );
}
