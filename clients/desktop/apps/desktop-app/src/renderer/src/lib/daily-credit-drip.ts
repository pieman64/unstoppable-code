import {
  parseDailyCreditDripPreferenceSaveResult,
  type DailyCreditDripPreferenceSaveResult,
} from '@canopy/protocol/billing';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { AiCreditsAvailability } from '@/hooks/useAiCreditsAvailability';
import { refreshAiCreditsAfterDripChange } from './ai-credits-refresh';

/**
 * Renderer-wide signal that the daily free-credit drip choice was saved from
 * one surface (Home card, Settings toggle, `needs-credits` recovery, App
 * Advisor), so every other mounted surface adopts it without a reload. The
 * event detail is the saved {@link DailyCreditDripPreferenceSaveResult}.
 */
export const DAILY_CREDIT_DRIP_CHANGED_EVENT =
  'canopy:daily-credit-drip-changed';

/** A committed drip save plus the settled fresh AI-credits read. */
export interface DailyCreditDripSaveOutcome {
  result: DailyCreditDripPreferenceSaveResult;
  /**
   * Resolves with the fresh availability read once every renderer cache was
   * refreshed. Never rejects; callers that do not need the new balance can
   * ignore it.
   */
  refreshed: Promise<AiCreditsAvailability>;
  /**
   * The cloud account changed while the save was in flight, so `result`
   * belongs to the previous account. It was not broadcast; callers must not
   * apply it to the current account's state either.
   */
  accountChanged: boolean;
}

/**
 * Save the daily free-credit drip choice through main, then broadcast the
 * saved preference (unless the account changed mid-save) and refresh every
 * renderer AI-credits cache. Rejects only when the save itself failed (no
 * credential, route unavailable, network or server error), so callers roll
 * back optimistic state only then.
 */
export async function saveDailyCreditDripChoice(
  enabled: boolean,
): Promise<DailyCreditDripSaveOutcome> {
  let accountChanged = false;
  const onAccountChanged = (): void => {
    accountChanged = true;
  };
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, onAccountChanged);
  let result: DailyCreditDripPreferenceSaveResult;
  try {
    result = await window.api.saveCloudDailyCreditDrip({ enabled });
  } finally {
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
  }
  // A result for the previous account must not overwrite surfaces that have
  // already re-read the new account's preference.
  if (!accountChanged) {
    window.dispatchEvent(
      new CustomEvent<DailyCreditDripPreferenceSaveResult>(
        DAILY_CREDIT_DRIP_CHANGED_EVENT,
        { detail: result },
      ),
    );
  }
  return {
    result,
    refreshed: refreshAiCreditsAfterDripChange(),
    accountChanged,
  };
}

/**
 * Subscribe to {@link DAILY_CREDIT_DRIP_CHANGED_EVENT}. Returns the
 * unsubscribe function.
 */
export function onDailyCreditDripChanged(
  listener: (result: DailyCreditDripPreferenceSaveResult) => void,
): () => void {
  const handler = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const result = parseDailyCreditDripPreferenceSaveResult(event.detail);
    if (result) listener(result);
  };
  window.addEventListener(DAILY_CREDIT_DRIP_CHANGED_EVENT, handler);
  return (): void => {
    window.removeEventListener(DAILY_CREDIT_DRIP_CHANGED_EVENT, handler);
  };
}
