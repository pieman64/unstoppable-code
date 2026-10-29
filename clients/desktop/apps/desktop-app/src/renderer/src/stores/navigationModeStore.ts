import { create } from 'zustand';
import type {
  NavigationMode,
  PreferencesData,
} from '@canopy/desktop-shared/types';

/**
 * Renderer mirror of `PreferencesData.navigationMode` (CAN-1817), the Code
 * vs Work navigation mode. Every mode-aware surface (New Task branch picker,
 * Add workspace remote option, Settings → General) reads this store so a
 * Settings change applies immediately, without a reload. Main owns the
 * persisted value; this store only mirrors it and issues saves.
 */
interface NavigationModeState {
  mode: NavigationMode;
  hydrated: boolean;
  /** Idempotent while hydrated; reads the startup snapshot when provided. */
  hydrate: (preferences?: PreferencesData) => Promise<boolean>;
  /**
   * Applies the mode optimistically and persists it. Rejects (after
   * restoring the previous mode) when the save fails so callers can explain.
   */
  setMode: (mode: NavigationMode) => Promise<void>;
}

let preferencesSyncSubscribed = false;
let hydrationPromise: Promise<boolean> | null = null;
/**
 * Monotonic version for canonical reads. Preference broadcasts wait for
 * cloud sync and can arrive out of order, so a snapshot is only an
 * invalidation signal: every broadcast triggers a fresh `loadPreferences`
 * read and only the newest outstanding read may write the store. `setMode`
 * bumps the version too, so a read started before an explicit change can
 * never overwrite it.
 */
let canonicalReadVersion = 0;
/**
 * Monotonic generation for explicit mode changes. Overlapping `setMode`
 * calls can settle out of order, so a rejected save only rolls back while
 * it is still the latest change; a stale failure defers to the canonical
 * preferences instead of overwriting a newer selection.
 */
let mutationGeneration = 0;
/**
 * Last mode confirmed by main: the startup snapshot, a canonical read, or a
 * successful save. Rollbacks restore this value, never an earlier optimistic
 * one, so two overlapping failures cannot strand the renderer on a mode that
 * was never persisted.
 */
let lastConfirmedMode: NavigationMode = 'code';

function applyCanonicalRead(
  set: (partial: Partial<NavigationModeState>) => void,
): void {
  if (typeof window.api?.loadPreferences !== 'function') return;
  const version = ++canonicalReadVersion;
  // Start the read on a resolved promise so a synchronous throw from a
  // partial test double or a torn-down bridge lands in `.catch` below.
  void Promise.resolve()
    .then(() => window.api.loadPreferences())
    .then((current) => {
      if (version !== canonicalReadVersion) return;
      lastConfirmedMode = current.navigationMode;
      set({ mode: current.navigationMode, hydrated: true });
    })
    .catch(() => {
      // Keep the last confirmed mode until another sync can be read.
    });
}

function ensurePreferencesSyncSubscription(
  set: (partial: Partial<NavigationModeState>) => void,
): void {
  // Guarded lookups keep app-shell tests with partial window.api mocks
  // rendering; production always exposes the method.
  if (
    preferencesSyncSubscribed ||
    typeof window.api?.onPreferencesSynced !== 'function'
  ) {
    return;
  }
  preferencesSyncSubscribed = true;
  // App-lifetime subscription; the unsubscribe handle is intentionally
  // dropped because this store lives for the whole renderer session.
  window.api.onPreferencesSynced(() => {
    applyCanonicalRead(set);
  });
}

export const useNavigationModeStore = create<NavigationModeState>(
  (set, get) => ({
    mode: 'code',
    hydrated: false,
    hydrate: (preferences?: PreferencesData): Promise<boolean> => {
      ensurePreferencesSyncSubscription(set);
      if (preferences) {
        lastConfirmedMode = preferences.navigationMode;
        set({ mode: preferences.navigationMode, hydrated: true });
        return Promise.resolve(true);
      }
      if (get().hydrated) return Promise.resolve(true);
      if (hydrationPromise) return hydrationPromise;
      if (typeof window.api?.loadPreferences !== 'function') {
        return Promise.resolve(false);
      }
      const version = ++canonicalReadVersion;
      hydrationPromise = window.api
        .loadPreferences()
        .then((loaded) => {
          if (version === canonicalReadVersion) {
            lastConfirmedMode = loaded.navigationMode;
            set({ mode: loaded.navigationMode, hydrated: true });
          }
          return true;
        })
        .catch(() => false)
        .finally(() => {
          hydrationPromise = null;
        });
      return hydrationPromise;
    },
    setMode: async (mode: NavigationMode): Promise<void> => {
      ensurePreferencesSyncSubscription(set);
      if (get().mode === mode && get().hydrated) return;
      // An explicit change outranks any canonical read already in flight.
      canonicalReadVersion += 1;
      const generation = ++mutationGeneration;
      set({ mode, hydrated: true });
      try {
        await window.api.savePreferences({ navigationMode: mode });
        if (generation === mutationGeneration) lastConfirmedMode = mode;
      } catch (error) {
        if (generation === mutationGeneration) {
          // Roll back to what main last confirmed, not to an earlier
          // optimistic value that may itself have failed to persist.
          set({ mode: lastConfirmedMode });
        }
        // Whether or not this was the latest change, let canonical state
        // reconcile anything the overlapping saves left behind.
        applyCanonicalRead(set);
        throw error;
      }
    },
  }),
);

/** Reactive read of the current navigation mode. */
export function useNavigationMode(): NavigationMode {
  return useNavigationModeStore((state) => state.mode);
}
