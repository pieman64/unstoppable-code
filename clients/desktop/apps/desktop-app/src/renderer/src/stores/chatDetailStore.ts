import { useEffect } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_CHAT_DETAIL,
  normalizeChatDetail,
  type ChatDetail,
} from '@canopy/protocol/chat-detail';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';

export interface ChatDetailState {
  /** The default level until the saved preference says otherwise. */
  detail: ChatDetail;
  /** True once the saved preference loaded (or could not load). */
  hydrated: boolean;
  /**
   * Applies the level at once and persists it. Rejects (after restoring the
   * last saved value) when the save fails so callers can explain.
   */
  setDetail: (detail: ChatDetail) => Promise<void>;
}

let subscribed = false;
/**
 * Monotonic version for canonical reads. Preference broadcasts can arrive out
 * of order, so each one triggers a fresh read and only the newest outstanding
 * read may write. `setDetail` bumps it so an older read cannot overwrite an
 * explicit change.
 */
let canonicalReadVersion = 0;
/** Overlapping saves can settle out of order; only the latest rolls back. */
let mutationGeneration = 0;
/**
 * Saves still in flight. A read that lands meanwhile can predate the commit
 * (another window's save broadcasts first), so it is dropped: the save's own
 * result is read after commit, and a failure reads again.
 */
let pendingSaves = 0;
/** Last value main confirmed. Rollbacks restore this, never an optimistic one. */
let lastConfirmed: ChatDetail = DEFAULT_CHAT_DETAIL;

function applyCanonicalRead(): void {
  if (typeof window.api?.loadPreferences !== 'function') {
    useChatDetailStore.setState({ hydrated: true });
    return;
  }
  const version = ++canonicalReadVersion;
  // A resolved promise first so a synchronous throw from a partial test
  // double or a torn-down bridge lands in `.catch`.
  void Promise.resolve()
    .then(() => window.api.loadPreferences())
    .then((preferences) => {
      if (version !== canonicalReadVersion || pendingSaves > 0) return;
      lastConfirmed = normalizeChatDetail(preferences.chatDetail);
      useChatDetailStore.setState({ detail: lastConfirmed, hydrated: true });
    })
    .catch(() => {
      if (version !== canonicalReadVersion || pendingSaves > 0) return;
      // Keep the last confirmed value until another sync can be read.
      useChatDetailStore.setState({ hydrated: true });
    });
}

/**
 * Loads the saved level and follows changes for the lifetime of the window.
 * Idempotent; safe to call from every consumer.
 */
export function ensureChatDetailSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  // App-lifetime subscription; guarded so tests with a partial `window.api`
  // still render.
  if (typeof window.api?.onPreferencesSynced === 'function') {
    window.api.onPreferencesSynced(() => {
      applyCanonicalRead();
    });
  }
  applyCanonicalRead();
}

/**
 * Renderer mirror of `PreferencesData.chatDetail` (Appearance → "Chat
 * detail"). Main owns the persisted value; the store reads it once, follows
 * `preferences:synced`, so open chats change as soon as a window saves, and
 * issues saves from Settings.
 */
export const useChatDetailStore = create<ChatDetailState>((set, get) => ({
  detail: DEFAULT_CHAT_DETAIL,
  hydrated: false,
  setDetail: async (detail: ChatDetail): Promise<void> => {
    ensureChatDetailSubscription();
    // An explicit change outranks any canonical read already in flight.
    canonicalReadVersion += 1;
    const generation = ++mutationGeneration;
    if (get().detail !== detail) set({ detail });
    pendingSaves += 1;
    let saved: PreferencesSaveResult;
    try {
      saved = await window.api.savePreferences({ chatDetail: detail });
    } catch (error) {
      pendingSaves -= 1;
      if (generation === mutationGeneration) set({ detail: lastConfirmed });
      // Let canonical state reconcile whatever overlapping saves left.
      applyCanonicalRead();
      throw error;
    }
    pendingSaves -= 1;
    if (generation !== mutationGeneration) return;
    lastConfirmed = normalizeChatDetail(saved.chatDetail);
    set({ detail: lastConfirmed, hydrated: true });
  },
}));

/** The saved chat detail level; the default until it loads. */
export function useChatDetailPreference(): ChatDetail {
  const detail = useChatDetailStore((state) => state.detail);
  useEffect(() => {
    ensureChatDetailSubscription();
  }, []);
  return detail;
}
