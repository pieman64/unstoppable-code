import { setSingleDollarMathEnabled } from '@canopy/ui-shared/components/Markdown';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { subscribePreferencesUpdated } from './preferences-events';

let initialization: Promise<void> | null = null;
let revision = 0;
let unsubscribeSynced: (() => void) | null = null;
let unsubscribeLocal: (() => void) | null = null;

function applyPreferences(preferences: PreferencesData): void {
  revision += 1;
  // Absent means a file from before the setting existed: keep the default.
  setSingleDollarMathEnabled(preferences.singleDollarMath !== false);
}

/**
 * Applies the Display setting for `$...$` math (CAN-5124) to shared Markdown
 * before React mounts, then follows saves. A newer broadcast wins over the
 * initial load; a failed load keeps the default (on).
 */
export function initializeMarkdownMathPreference(): Promise<void> {
  if (initialization !== null) return initialization;
  const before = revision;
  unsubscribeSynced = window.api.onPreferencesSynced(applyPreferences);
  unsubscribeLocal = subscribePreferencesUpdated(applyPreferences);
  initialization = (async (): Promise<void> => {
    try {
      const preferences = await window.api.loadPreferences();
      if (revision === before) applyPreferences(preferences);
    } catch {
      // Keep the default until a preference broadcast arrives.
    }
  })();
  return initialization;
}

export function disposeMarkdownMathPreference(): void {
  revision += 1;
  unsubscribeSynced?.();
  unsubscribeLocal?.();
  unsubscribeSynced = null;
  unsubscribeLocal = null;
  initialization = null;
  setSingleDollarMathEnabled(true);
}
