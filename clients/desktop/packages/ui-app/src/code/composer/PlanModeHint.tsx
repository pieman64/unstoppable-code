'use client';

import type { JSX } from 'react';
import { PlanModeIcon } from '@canopy/ui-shared/icons';
import { ComposerHint } from '../../onboarding-tips/ComposerHint';
import type { PlanModeSuggestion } from './usePlanModeSuggestion';

export interface PlanModeHintProps {
  /** The composer's `usePlanModeSuggestion` result. */
  readonly hint: PlanModeSuggestion;
  readonly appearance?: 'drawer' | 'notice';
}

/**
 * The plan mode suggestion for a long, multi-step draft (CAN-4008), drawn
 * as the composer's tip. Hosts place it first in their top `ComposerDrawer`;
 * it renders nothing while the hook keeps it hidden. Accepting turns plan
 * mode on and leaves the draft as it is.
 */
export function PlanModeHint({
  hint,
  appearance = 'drawer',
}: PlanModeHintProps): JSX.Element | null {
  if (!hint.visible) return null;
  return (
    <ComposerHint
      appearance={appearance}
      icon={<PlanModeIcon size="sm" aria-hidden="true" />}
      title="Plan first?"
      action={{
        label: 'Plan first',
        onClick: (): void => void hint.accept(),
        busy: hint.pending,
        testId: 'plan-mode-suggestion-accept',
      }}
      onDismiss={hint.dismiss}
      dismissAriaLabel="Dismiss plan mode suggestion"
      data-testid="plan-mode-suggestion"
    >
      This looks like a multi-step task. Plan mode works out the approach before
      making changes.
    </ComposerHint>
  );
}
