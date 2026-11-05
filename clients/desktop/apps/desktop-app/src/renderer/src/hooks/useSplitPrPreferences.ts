import { useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';

/**
 * The preference fields that gate the Split PR affordances (activity-panel
 * button and worktree-row menu item).
 */
export interface SplitPrGatingPreferences {
  splitPrEnabled: boolean;
  splitPrThresholdLines: number;
}

interface SplitPrPreferencesState extends SplitPrGatingPreferences {
  hasLoaded: boolean;
  load: () => Promise<void>;
}

let loadStarted = false;

/**
 * Shared, lazily-loaded snapshot of the Split PR gating preferences.
 *
 * Worktree rows and the PR activity panel both need these fields reactively,
 * but a `loadPreferences()` IPC call per row would be a request storm, so the
 * values live in one module-level store: loaded once on first use and kept in
 * sync via the same-renderer `canopy:preferences-updated` event that settings
 * tabs emit after saving.
 *
 * Until the first load resolves, the defaults keep Split PR hidden (strict
 * gating — affordances must never flash for ineligible worktrees).
 */
export const useSplitPrPreferencesStore = create<SplitPrPreferencesState>(
  (set) => ({
    splitPrEnabled: false,
    splitPrThresholdLines: Number.MAX_SAFE_INTEGER,
    hasLoaded: false,
    load: async (): Promise<void> => {
      if (loadStarted) return;
      loadStarted = true;
      try {
        const prefs: PreferencesData = await window.api.loadPreferences();
        set({
          splitPrEnabled: prefs.splitPrEnabled,
          splitPrThresholdLines: prefs.splitPrThresholdLines,
          hasLoaded: true,
        });
      } catch {
        // Preferences unavailable — keep the disabled defaults and allow a
        // later subscriber to retry.
        loadStarted = false;
      }
    },
  }),
);

subscribePreferencesUpdated((prefs) => {
  useSplitPrPreferencesStore.setState({
    splitPrEnabled: prefs.splitPrEnabled,
    splitPrThresholdLines: prefs.splitPrThresholdLines,
    hasLoaded: true,
  });
});

/**
 * Reactive read of the Split PR gating preferences. Triggers the shared
 * one-time load on first mount; every consumer shares the same snapshot.
 */
export function useSplitPrGatingPreferences(): SplitPrGatingPreferences {
  const load = useSplitPrPreferencesStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return useSplitPrPreferencesStore(
    useShallow((s) => ({
      splitPrEnabled: s.splitPrEnabled,
      splitPrThresholdLines: s.splitPrThresholdLines,
    })),
  );
}
