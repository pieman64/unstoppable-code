import { useEffect } from 'react';
import { useSuggestionsStore } from '@canopy/app-state';
import {
  parseSuggestionsState,
  type SuggestionId,
  type SuggestionsState,
} from '@canopy/protocol/suggestions';
import { setOsNotificationOfferSuggestionsGate } from '@/lib/osNotificationOffer';
import { stopRepeatTaskSuggestions } from '@/lib/repeat-task-automation/settings';

/** Null until the host's state is known; producers then fail closed. */
function categoryGate(
  committed: SuggestionsState | null,
  id: SuggestionId,
): boolean | null {
  if (committed === null) return null;
  return committed.enabled && committed.dismissed[id] === undefined;
}

/**
 * Keeps the shared suggestions state (CAN-4343) in step with the desktop
 * preferences, and applies committed state to the renderer-owned producers:
 * the notification offer arms only while its gate is on, and a committed off
 * (or Don't show again) clears repeated-task history and its pending offer.
 * Main gates its own producers (skill share, skill suggestions).
 */
export function SuggestionsPreferencesBridge(): null {
  const sync = useSuggestionsStore((state) => state.sync);
  const committed = useSuggestionsStore((state) => state.committed);
  useEffect(
    () =>
      window.api.onPreferencesSynced((preferences) => {
        const state = parseSuggestionsState(preferences.suggestions);
        if (state !== null) sync(state);
      }),
    [sync],
  );
  const osGate = categoryGate(committed, 'os-notification-offer');
  const repeatGate = categoryGate(committed, 'repeat-task-automation');
  useEffect(() => {
    setOsNotificationOfferSuggestionsGate(osGate);
  }, [osGate]);
  useEffect(() => {
    if (repeatGate === false) stopRepeatTaskSuggestions();
  }, [repeatGate]);
  return null;
}
