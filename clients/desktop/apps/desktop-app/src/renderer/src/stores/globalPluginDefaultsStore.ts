import { create } from 'zustand';
import type {
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { emptyPluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';

/**
 * Renderer mirror of `PreferencesData.globalPluginSelections` — the global
 * default-plugin overlay. Display-only: pickers use it to show the effective
 * selection set and to split saves into local selections + tombstones. The
 * main process owns resolution; this store never persists anything.
 */
interface GlobalPluginDefaultsState {
  selections: ChatTabPluginSelections;
  hydrated: boolean;
  /** In-store so a failed initial load can be retried by a later call. */
  loadInFlight: boolean;
  /** Idempotent while a load is pending or done; retries after a failure. */
  hydrate: (preferences?: PreferencesData) => Promise<boolean>;
}

let preferencesSyncSubscribed = false;
let hydrationPromise: Promise<boolean> | null = null;

export const useGlobalPluginDefaultsStore = create<GlobalPluginDefaultsState>(
  (set, get) => ({
    selections: emptyPluginSelections(),
    hydrated: false,
    loadInFlight: false,
    hydrate: (preferences?: PreferencesData): Promise<boolean> => {
      // Guarded lookups keep app-shell tests with partial window.api mocks
      // rendering; production always exposes both methods.
      if (
        !preferencesSyncSubscribed &&
        typeof window.api?.onPreferencesSynced === 'function'
      ) {
        preferencesSyncSubscribed = true;
        // App-lifetime subscription; the unsubscribe handle is intentionally
        // dropped because this store lives for the whole renderer session.
        window.api.onPreferencesSynced((preferences) => {
          set({
            selections:
              preferences.globalPluginSelections ?? emptyPluginSelections(),
            hydrated: true,
          });
        });
      }
      if (preferences) {
        set({
          selections:
            preferences.globalPluginSelections ?? emptyPluginSelections(),
          hydrated: true,
        });
        return Promise.resolve(true);
      }
      if (get().hydrated) return Promise.resolve(true);
      if (hydrationPromise) return hydrationPromise;
      if (typeof window.api?.loadPreferences !== 'function') {
        return Promise.resolve(false);
      }
      set({ loadInFlight: true });
      hydrationPromise = window.api
        .loadPreferences()
        .then((preferences) => {
          set({
            selections:
              preferences.globalPluginSelections ?? emptyPluginSelections(),
            hydrated: true,
          });
          return true;
        })
        .catch(() => {
          // Leave `hydrated` false so a later hydrate() (e.g. opening the
          // plugins modal) retries instead of silently serving an empty
          // overlay forever.
          return false;
        })
        .finally(() => {
          hydrationPromise = null;
          set({ loadInFlight: false });
        });
      return hydrationPromise;
    },
  }),
);
