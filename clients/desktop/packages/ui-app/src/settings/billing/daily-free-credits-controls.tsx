'use client';

import { useState, type JSX } from 'react';
import type { DailyCreditDripPreferenceInput } from '@canopy/protocol/billing';
import {
  DailyFreeCreditsOffer,
  dailyFreeCreditsTitle,
  dailyFreeCreditsToggleLabel,
} from '@canopy/ui-shared/components';
import { formatCredits } from '@canopy/ui-shared/lib';
import { BillingTogglePanel } from './billing-toggle-panel';

/**
 * Billing-tab opt-in for free daily AI credits. The switch flips
 * optimistically, then `save` persists the choice (and refreshes the card).
 * The switch rolls back, with an inline error, only when `save` rejects, which
 * the caller limits to the preference PUT itself failing: a saved preference
 * whose follow-up balance reload fails still counts as saved.
 */
export interface DailyFreeCreditsControlsProps {
  /** Saved opt-in state from the credits summary. */
  enabled: boolean;
  /** The plan's daily cap, shown even while opted out. */
  capCredits: number;
  /** Persist the choice and refresh; rejects only when the save fails. */
  save: (input: DailyCreditDripPreferenceInput) => Promise<void>;
}

const SAVE_ERROR = "Couldn't save. Try again.";

export function DailyFreeCreditsControls({
  enabled,
  capCredits,
  save,
}: DailyFreeCreditsControlsProps): JSX.Element {
  const [checked, setChecked] = useState(enabled);
  const [savedEnabled, setSavedEnabled] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt a new saved value from the summary (a reload after this or another
  // save) without an effect, per React's "adjusting state on prop change".
  if (enabled !== savedEnabled) {
    setSavedEnabled(enabled);
    setChecked(enabled);
  }

  const handleToggle = (): void => {
    const previous = checked;
    const next = !previous;
    setChecked(next);
    setBusy(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        await save({ enabled: next });
      } catch {
        setChecked(previous);
        setError(SAVE_ERROR);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <BillingTogglePanel
      testId="billing-daily-drip"
      toggleTestId="billing-daily-drip-toggle"
      title={dailyFreeCreditsTitle('AI credits')}
      description={
        <DailyFreeCreditsOffer
          term="AI credits"
          formattedCap={formatCredits(capCredits)}
        />
      }
      checked={checked}
      ariaLabel={dailyFreeCreditsToggleLabel('AI credits')}
      disabled={busy}
      onToggle={handleToggle}
      error={error}
    />
  );
}
