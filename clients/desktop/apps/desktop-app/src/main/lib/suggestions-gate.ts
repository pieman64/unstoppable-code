import type { PreferencesData } from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from './main-process-logging';
import {
  SUGGESTION_IDS,
  type SuggestionId,
  type SuggestionsState,
} from '@canopy/protocol/suggestions';

/** Last committed profile only. Unknown startup state refuses all production. */
let state: SuggestionsState | null = null;
let childEnabled = false;
let revision = 0;
const categoryRevisions = new Map<SuggestionId, number>();
const listeners = new Set<() => void>();
export function hasSuggestionsPreferences(): boolean {
  return state !== null;
}
export function suggestionsGateRevision(id?: SuggestionId): number {
  return id === undefined ? revision : (categoryRevisions.get(id) ?? 0);
}
/** Only this explicit child opt-out authorizes a skill-history purge. */
export function isSkillSuggestionsChildPreferenceEnabled(): boolean {
  return childEnabled;
}
export function isSuggestionAllowed(id: SuggestionId): boolean {
  return (
    state?.enabled === true &&
    state.dismissed[id] === undefined &&
    (id !== 'skill-suggestion' || childEnabled)
  );
}
export function commitSuggestionsGate(
  preferences: Pick<PreferencesData, 'suggestions' | 'skillSuggestionsEnabled'>,
): void {
  const before = new Map(
    SUGGESTION_IDS.map((id) => [id, isSuggestionAllowed(id)]),
  );
  const changed =
    state === null ||
    state.enabled !== preferences.suggestions.enabled ||
    JSON.stringify(state.dismissed) !==
      JSON.stringify(preferences.suggestions.dismissed) ||
    childEnabled !== (preferences.skillSuggestionsEnabled !== false);
  state = preferences.suggestions;
  childEnabled = preferences.skillSuggestionsEnabled !== false;
  if (!changed) return;
  revision += 1;
  for (const id of SUGGESTION_IDS) {
    if (before.get(id) !== isSuggestionAllowed(id))
      categoryRevisions.set(id, (categoryRevisions.get(id) ?? 0) + 1);
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logMainProcessWarn('[suggestions] gate listener failed', error);
    }
  }
}
export function subscribeSuggestionsGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
