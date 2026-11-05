import { logMainProcessWarn } from './main-process-logging';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  applySuggestionsUpdate,
  parseSuggestionsUpdate,
  type SuggestionsState,
} from '@canopy/protocol/suggestions';
import {
  readPreferencesFileDetailed,
  updatePreferencesFile,
} from './preferences-store';
import {
  commitSuggestionsGate,
  suggestionsGateRevision,
} from './suggestions-gate';

export async function readSuggestionsPreferences(): Promise<SuggestionsState> {
  const { preferences, authority } = await readPreferencesFileDetailed();
  if (authority === 'unreadable')
    throw new Error('Preferences could not be read.');
  return preferences.suggestions;
}
let hydration: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let hydrationGeneration = 0;

/** Startup runs in the background; failed reads retry without opening defaults. */
export function initializeSuggestionsGate(): Promise<void> {
  if (hydration !== null) return hydration;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
  const generation = hydrationGeneration;
  const revision = suggestionsGateRevision();
  const attempt = (async (): Promise<void> => {
    try {
      const { preferences, authority } = await readPreferencesFileDetailed();
      if (
        generation !== hydrationGeneration ||
        revision !== suggestionsGateRevision()
      )
        return;
      if (authority === 'unreadable')
        throw new Error('Preferences could not be read.');
      commitSuggestionsGate(preferences);
    } catch (error) {
      if (
        generation !== hydrationGeneration ||
        revision !== suggestionsGateRevision()
      )
        return;
      logMainProcessWarn('[suggestions] preference hydration failed', error);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void initializeSuggestionsGate();
      }, 5_000);
      retryTimer.unref();
    }
  })();
  hydration = attempt;
  void attempt.finally(() => {
    if (hydration === attempt) hydration = null;
  });
  return attempt;
}

export function stopSuggestionsGateHydration(): void {
  hydrationGeneration += 1;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
  hydration = null;
}

export async function updateSuggestionsPreferences(
  request: unknown,
): Promise<PreferencesData> {
  const update = parseSuggestionsUpdate(request);
  if (update === null) throw new Error('Invalid suggestions update.');
  // The updater runs after an authoritative read in the existing writer queue.
  return updatePreferencesFile((latest) => ({
    suggestions: applySuggestionsUpdate(latest.suggestions, update, new Date()),
  }));
}
