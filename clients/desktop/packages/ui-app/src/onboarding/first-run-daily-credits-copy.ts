import {
  dailyFreeCreditsTitle,
  formatCreditCount,
} from '@canopy/ui-shared/components';
import type { DailyCreditDripPreferenceSaveResult } from '@canopy/protocol/billing';

/** Visible label and accessible name of the first-run daily credits switch. */
export const FIRST_RUN_DAILY_CREDITS_LABEL =
  dailyFreeCreditsTitle('AI Credits');

export function firstRunDailyCreditsOffer(capCredits: number): string {
  return `No card needed · ${formatCreditCount(capCredits)} AI Credits every day`;
}

export function firstRunDailyCreditsGranted(granted: number): string {
  return `${formatCreditCount(granted)} free AI Credits added · refills daily`;
}

export const FIRST_RUN_DAILY_CREDITS_ENABLED = `${FIRST_RUN_DAILY_CREDITS_LABEL} enabled.`;

/** What the server reported for a turn-on saved from the first-run row. */
export type DailyCreditDripSaveOutcome = Pick<
  DailyCreditDripPreferenceSaveResult,
  'granted' | 'balanceCredits' | 'blockedReason'
>;

export type DailyCreditsRowState = 'offer' | 'granted' | 'enabled';

/**
 * Which description a settled turn-on earns. A blocked reason wins over any
 * grant, even a contradictory one; only an unblocked positive grant says
 * credits were added, and a zero grant only acknowledges the choice.
 */
export function dailyCreditsRowState(
  outcome: DailyCreditDripSaveOutcome | null,
  enabled: boolean,
): DailyCreditsRowState {
  if (outcome === null || !enabled || outcome.blockedReason !== undefined) {
    return 'offer';
  }
  return outcome.granted > 0 ? 'granted' : 'enabled';
}
