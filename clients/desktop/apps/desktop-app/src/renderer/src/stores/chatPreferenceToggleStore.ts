import { useEffect } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';

/** The chat's on/off preferences that a renderer store mirrors. */
export type ChatPreferenceToggleKey =
  | 'chatLiveStepWindowEnabled'
  | 'chatGroupToolCallsEnabled';

export interface ChatPreferenceToggleState {
  /** Off until the saved preference says otherwise. */
  enabled: boolean;
  /** True once the saved preference loaded (or could not load). */
  hydrated: boolean;
  /**
   * Applies the choice at once and persists it. Rejects (after restoring the
   * last saved value) when the save fails so callers can explain.
   */
  setEnabled: (enabled: boolean) => Promise<void>;
}

export interface ChatPreferenceToggleStore {
  useStore: UseBoundStore<StoreApi<ChatPreferenceToggleState>>;
  /**
   * Loads the saved preference and follows changes for the lifetime of the
   * window. Idempotent; safe to call from every consumer.
   */
  ensureSubscription: () => void;
  /** Whether the preference is on. Reads false until loaded. */
  useEnabled: () => boolean;
  /** Test-only: forget the subscription and return to the defaults. */
  resetForTest: () => void;
}

/**
 * Renderer mirror of one boolean chat preference in `PreferencesData`. Main
 * owns the persisted value; the store reads it once, follows
 * `preferences:synced`, and issues saves from Settings.
 */
export function createChatPreferenceToggleStore(
  key: ChatPreferenceToggleKey,
): ChatPreferenceToggleStore {
  let subscribed = false;
  /**
   * Monotonic version for canonical reads. Preference broadcasts can arrive
   * out of order, so each one triggers a fresh read and only the newest
   * outstanding read may write. `setEnabled` bumps it so an older read cannot
   * overwrite an explicit change.
   */
  let canonicalReadVersion = 0;
  /** Overlapping saves can settle out of order; only the latest rolls back. */
  let mutationGeneration = 0;
  /**
   * Saves still in flight. A read that lands meanwhile can predate the commit
   * (another window's save broadcasts first), so it is dropped: the save's
   * own result is read after commit, and a failure reads again.
   */
  let pendingSaves = 0;
  /** Last value main confirmed. Rollbacks restore this, never an optimistic one. */
  let lastConfirmed = false;

  function applyCanonicalRead(): void {
    if (typeof window.api?.loadPreferences !== 'function') {
      useStore.setState({ hydrated: true });
      return;
    }
    const version = ++canonicalReadVersion;
    // A resolved promise first so a synchronous throw from a partial test
    // double or a torn-down bridge lands in `.catch`.
    void Promise.resolve()
      .then(() => window.api.loadPreferences())
      .then((preferences) => {
        if (version !== canonicalReadVersion || pendingSaves > 0) return;
        lastConfirmed = preferences[key] === true;
        useStore.setState({ enabled: lastConfirmed, hydrated: true });
      })
      .catch(() => {
        if (version !== canonicalReadVersion || pendingSaves > 0) return;
        // Keep the last confirmed value until another sync can be read.
        useStore.setState({ hydrated: true });
      });
  }

  function ensureSubscription(): void {
    if (subscribed) return;
    subscribed = true;
    // App-lifetime subscription; guarded so tests with a partial
    // `window.api` still render.
    if (typeof window.api?.onPreferencesSynced === 'function') {
      window.api.onPreferencesSynced(() => {
        applyCanonicalRead();
      });
    }
    applyCanonicalRead();
  }

  const useStore = create<ChatPreferenceToggleState>((set, get) => ({
    enabled: false,
    hydrated: false,
    setEnabled: async (enabled: boolean): Promise<void> => {
      ensureSubscription();
      // An explicit change outranks any canonical read already in flight.
      canonicalReadVersion += 1;
      const generation = ++mutationGeneration;
      if (get().enabled !== enabled) set({ enabled });
      pendingSaves += 1;
      let saved: PreferencesSaveResult;
      try {
        saved = await window.api.savePreferences({ [key]: enabled });
      } catch (error) {
        pendingSaves -= 1;
        if (generation === mutationGeneration) {
          set({ enabled: lastConfirmed });
        }
        // Let canonical state reconcile whatever overlapping saves left.
        applyCanonicalRead();
        throw error;
      }
      pendingSaves -= 1;
      if (generation !== mutationGeneration) return;
      lastConfirmed = saved[key] === true;
      set({ enabled: lastConfirmed, hydrated: true });
    },
  }));

  function useEnabled(): boolean {
    const enabled = useStore((state) => state.enabled);
    useEffect(() => {
      ensureSubscription();
    }, []);
    return enabled;
  }

  function resetForTest(): void {
    subscribed = false;
    canonicalReadVersion += 1;
    mutationGeneration += 1;
    pendingSaves = 0;
    lastConfirmed = false;
    useStore.setState({ enabled: false, hydrated: false });
  }

  return { useStore, ensureSubscription, useEnabled, resetForTest };
}
