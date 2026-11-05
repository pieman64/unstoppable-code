import type { PreferencesLoadResult } from '@canopy/desktop-shared/types';
import { normalizeSuggestionsState } from '@canopy/protocol/suggestions';
import { clearRepeatTaskHistory, type RepeatTaskStorage } from './history';
import { useRepeatTaskOfferStore } from './offerStore';

/**
 * Whether repeated-task offers may be produced: the Settings → Suggestions
 * master switch is on and the category was not dismissed for good
 * (CAN-4343). A profile without the new field falls back to the legacy
 * repeated-task switch. `null` when the read is degraded, so a transient
 * failure neither records a task nor clears history.
 */
export function readRepeatTaskSuggestionsEnabled(
  preferences: Partial<
    Pick<
      PreferencesLoadResult,
      'suggestions' | 'repeatTaskAutomationSuggestionsEnabled'
    >
  > &
    Pick<PreferencesLoadResult, '__error'>,
): boolean | null {
  if (preferences.__error !== undefined) return null;
  const suggestions = normalizeSuggestionsState(
    preferences.suggestions,
    preferences.repeatTaskAutomationSuggestionsEnabled,
  );
  return (
    suggestions.enabled &&
    suggestions.dismissed['repeat-task-automation'] === undefined
  );
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

/**
 * Committed off (or a permanent dismissal) forgets recorded tasks and hides
 * the offer; a task already being compared drops out.
 */
export function stopRepeatTaskSuggestions(storage?: RepeatTaskStorage): void {
  stopCount += 1;
  useRepeatTaskOfferStore.setState({ offer: null });
  clearRepeatTaskHistory(storage);
}
