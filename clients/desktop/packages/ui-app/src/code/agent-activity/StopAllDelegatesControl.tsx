'use client';

import type { JSX } from 'react';
import {
  AGENT_ACTIVITY_STOP_ALL_LABEL,
  agentActivityStopAllPrompt,
} from '@canopy/ui-shared/components';
import { StopAllConfirmControl } from './StopAllConfirmControl';

export interface StopAllDelegatesControlProps {
  liveDelegationIds: readonly string[];
  onStopAll: () => Promise<boolean>;
  /**
   * The resting action's visible caption. Defaults to `Stop all delegates`;
   * a toolbar short on room passes `Stop all`. The accessible name always
   * says `Stop all delegates`, and the confirm step names the count.
   */
  label?: string;
  /** A section heading's quiet 28px action; confirmation stays explicit. */
  appearance?: 'default' | 'section';
  /** Test id of the resting action; its confirm parts add suffixes. */
  testId?: string;
}

/**
 * Stop all delegates and their descendants. Section actions confirm in a
 * dialog to preserve the heading; existing toolbar actions confirm inline.
 */
export function StopAllDelegatesControl({
  liveDelegationIds,
  onStopAll,
  label = AGENT_ACTIVITY_STOP_ALL_LABEL,
  appearance = 'default',
  testId = 'agent-activity-stop-all',
}: StopAllDelegatesControlProps): JSX.Element | null {
  return (
    <StopAllConfirmControl
      liveIds={liveDelegationIds}
      onStopAll={onStopAll}
      label={label}
      accessibleLabel={AGENT_ACTIVITY_STOP_ALL_LABEL}
      prompt={agentActivityStopAllPrompt}
      appearance={appearance}
      message="This stops the delegates and any tasks they started."
      testId={testId}
    />
  );
}
