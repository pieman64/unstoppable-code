import { createChatPreferenceToggleStore } from './chatPreferenceToggleStore';

/**
 * Renderer mirror of `PreferencesData.chatLiveStepWindowEnabled` (CAN-4274):
 * while a turn runs, the chat shows only its three most recent agent steps.
 * Off by default and independent of Early access and of grouping tool calls.
 * Main owns the persisted value; this store reads it once, follows
 * `preferences:synced`, and issues saves from Settings → Experiments.
 */
const liveStepWindow = createChatPreferenceToggleStore(
  'chatLiveStepWindowEnabled',
);

export const useChatLiveStepWindowStore = liveStepWindow.useStore;
export const ensureChatLiveStepWindowSubscription =
  liveStepWindow.ensureSubscription;
/** Whether the live step window is on. Reads false until loaded. */
export const useChatLiveStepWindowEnabled = liveStepWindow.useEnabled;
/** Test-only: forget the subscription and return the store to its defaults. */
export const resetChatLiveStepWindowStoreForTest = liveStepWindow.resetForTest;
