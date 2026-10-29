import type { PreferencesLoadResult } from '@canopy/desktop-shared/types';
import { clearRepeatTaskHistory, type RepeatTaskStorage } from './history';
import { useRepeatTaskOfferStore } from './offerStore';

/**
 * Whether Settings → "Suggest automations for repeated tasks" is on: `null`
 * when the read is degraded, so a transient failure neither records a task
 * nor clears history.
 */
export function readRepeatTaskSuggestionsEnabled(
  preferences: Pick<
    PreferencesLoadResult,
    '__error' | 'repeatTaskAutomationSuggestionsEnabled'
  >,
): boolean | null {
  if (preferences.__error !== undefined) return null;
  return preferences.repeatTaskAutomationSuggestionsEnabled !== false;
}

export async function loadRepeatTaskSuggestionsEnabled(): Promise<
  boolean | null
> {
  try {
    const api = typeof window === 'undefined' ? undefined : window.api;
    if (!api || typeof api.loadPreferences !== 'function') return null;
    return readRepeatTaskSuggestionsEnabled(await api.loadPreferences());
  } catch {
    return null;
  }
}

let stopCount = 0;

/** Changes whenever suggestions stop, so a task already being compared drops out. */
export function repeatTaskSuggestionsStopCount(): number {
  return stopCount;
}

/** Turning the setting off forgets recorded tasks and hides the offer. */
export function stopRepeatTaskSuggestions(storage?: RepeatTaskStorage): void {
  stopCount += 1;
  useRepeatTaskOfferStore.setState({ offer: null });
  clearRepeatTaskHistory(storage);
}
